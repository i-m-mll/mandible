// API routes for the chat log / conversation system.

import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { broadcast } from "../sse.js";
import { decompressContent, decompressContentAsync } from "../compression.js";
import { deriveConversationAttachState } from "../conversation-attach-state.js";
import {
  ClientAuthzError,
  operatorOnlyManagedSessionRoute,
  requireOperator,
} from "../client-auth/authz.js";
import {
  backfillCredentialLeakScan,
  maskUnverifiedCandidates,
  remediationFor,
  scanBlocksForCredentialLeaks,
} from "../credential-leak-scan.js";
import { triggerFullIngest } from "../ingestion.js";
import { transformContent } from "../transform.js";
import { getConversationSearchCache } from "../conversations/search-cache.js";
import {
  ConversationSidebarCursorError,
  buildConversationSidebar,
  type ConversationSidebarProject,
  type ConversationSidebarSort,
} from "../conversations/sidebar-projection.js";
import type { SessionManager } from "../session-manager.js";
import type { RouteRegistrar } from "../server.js";
import { readBody, sendJson } from "./http.js";
import { ConversationSourceReader } from "../conversations/source-reader.js";
import type { SourceBackedConversationBlock } from "../conversations/source-types.js";
import {
  ConversationFreshnessError,
  ensureExactConversationFresh,
} from "../conversations/freshness.js";
import type { ResponseLike } from "../server.js";

// --- Row mapping helpers ---

interface ConversationRow {
  id: string;
  source: string;
  source_path: string;
  source_hash: string;
  source_mtime: number;
  title: string;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  block_count: number;
  session_id: string;
  project_path: string | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  cli_version: string | null;
  starred: number;
  tags: string;
  notes: string | null;
  parent_conversation_id: string | null;
  is_sidechain: number;
  agent_id: string | null;
  children_count?: number;
  created_at: string;
  updated_at: string;
}

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

function mapConversation(row: ConversationRow, sessionManager?: SessionManager) {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    // The schema validates storage. Keep corrupt external fixtures readable.
  }
  return {
    id: row.id,
    source: row.source,
    source_path: row.source_path,
    source_hash: row.source_hash,
    source_mtime: row.source_mtime,
    title: row.title,
    summary: row.summary,
    started_at: row.started_at,
    ended_at: row.ended_at,
    block_count: row.block_count,
    session_id: row.session_id,
    project_path: row.project_path,
    cwd: row.cwd,
    branch: row.branch,
    model: row.model,
    cli_version: row.cli_version,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags,
    starred: row.starred === 1,
    parent_conversation_id: row.parent_conversation_id ?? null,
    is_sidechain: row.is_sidechain === 1,
    agent_id: row.agent_id ?? null,
    children_count: row.children_count ?? 0,
    attach_state: deriveConversationAttachState(row, getDb(), sessionManager),
  };
}

function maskSourceBackedConversationRow(row: ConversationRow): ConversationRow {
  return {
    ...row,
    title: maskUnverifiedCandidates(row.title).text,
    summary: row.summary == null ? null : maskUnverifiedCandidates(row.summary).text,
    notes: row.notes == null ? null : maskUnverifiedCandidates(row.notes).text,
  };
}

function mapSearchConversation(row: ConversationRow, sessionManager?: SessionManager) {
  return mapConversation(maskSourceBackedConversationRow(row), sessionManager);
}

type ProjectedConversationRow = ConversationRow & {
  canonical_project_id?: string | null;
  canonical_project_key?: string | null;
};

function mapSidebarConversation(
  row: ProjectedConversationRow,
  fullTextSearch: boolean,
  sessionManager?: SessionManager,
) {
  return {
    ...(fullTextSearch
      ? mapSearchConversation(row, sessionManager)
      : mapConversation(row, sessionManager)),
    canonical_project_id: row.canonical_project_id ?? null,
    canonical_project_key: row.canonical_project_key ?? null,
  };
}

const MAX_SIDEBAR_PROJECTS = 500;
const MAX_SIDEBAR_PROJECT_IDS_LENGTH = 32_768;

function parseSidebarProjectIds(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  if (raw.length > MAX_SIDEBAR_PROJECT_IDS_LENGTH) {
    throw new Error(`project_ids exceeds ${MAX_SIDEBAR_PROJECT_IDS_LENGTH} characters`);
  }
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => !value)) throw new Error("project_ids contains an empty id");
  const ids = [...new Set(values)];
  if (ids.length > MAX_SIDEBAR_PROJECTS) {
    throw new Error(`project_ids accepts at most ${MAX_SIDEBAR_PROJECTS} ids`);
  }
  return ids;
}

function loadSidebarProjects(db: ReturnType<typeof getDb>): ConversationSidebarProject[] {
  const projects = db.prepare(
    `SELECT id, project_key, display_name
     FROM ledger_projects
     ORDER BY id`,
  ).all() as Array<{ id: string; project_key: string; display_name: string }>;
  const roots = db.prepare(
    `SELECT project_id, root
     FROM ledger_project_checkouts
     ORDER BY project_id, root`,
  ).all() as Array<{ project_id: string; root: string }>;
  const rootsByProject = new Map<string, string[]>();
  for (const checkout of roots) {
    const existing = rootsByProject.get(checkout.project_id) ?? [];
    existing.push(checkout.root);
    rootsByProject.set(checkout.project_id, existing);
  }
  return projects.map((project) => ({
    ...project,
    checkout_roots: rootsByProject.get(project.id) ?? [],
  }));
}

function canonicalizeTags(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value as string[]) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
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
    SELECT 1 FROM conversation_blocks
     WHERE conversation_id = ? AND payload_state = 'source'
     LIMIT 1
  `).get(conversationId));
}

function sendFreshnessError(res: ResponseLike, error: unknown): boolean {
  if (!(error instanceof ConversationFreshnessError)) return false;
  if (error.code === "freshness_pending") {
    res.header?.("Retry-After", "1");
    res.status(error.status);
    if (res.empty) res.empty();
    else res.json(null);
    return true;
  }
  sendJson(res, error.status, {
    error: error.code,
    message: error.message,
    ...(error.candidates.length > 0 ? { candidates: error.candidates } : {}),
  });
  return true;
}

function parseSinceQuery(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d+d$/.test(value)) {
    const days = Number(value.slice(0, -1));
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }
  return value;
}

function sourceFromQuery(value: string | undefined): string | null {
  if (!value || value === "all") return null;
  return value === "claude" ? "claude_code" : value;
}

function blockTypeFromRole(value: string | undefined): string | null {
  if (value === "user") return "user_message";
  if (value === "assistant") return "assistant_message";
  return null;
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

export function registerConversationRoutes(server: RouteRegistrar, sessionManager?: SessionManager): void {
  const db = getDb();
  const sourceReader = new ConversationSourceReader(db);

  // --- Static routes MUST be registered before parameterized :id routes ---

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
  }, { fileRpc: "allow" });

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
  }, { fileRpc: "deny" });

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
        const where = ["EXISTS (SELECT 1 FROM conversation_blocks b WHERE b.conversation_id = c.id AND b.payload_state = 'source')"];
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
  }, { fileRpc: "allow" });

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
  }, { fileRpc: "deny" });

  // GET /api/conversations/sidebar — bounded, independently paged sidebar groups.
  server.get("/api/conversations/sidebar", async (req, res) => {
    const query = req.query ?? {};
    let requestedProjectIds: string[];
    try {
      requestedProjectIds = parseSidebarProjectIds(query.project_ids);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const projects = loadSidebarProjects(db);
    const knownProjectIds = new Set(projects.map((project) => project.id));
    const unknownProjectIds = requestedProjectIds.filter((id) => !knownProjectIds.has(id));
    if (unknownProjectIds.length > 0) {
      sendJson(res, 400, { error: "Unknown canonical project id", project_ids: unknownProjectIds });
      return;
    }
    const parsedLimit = parseInt(query.limit || "20", 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 20));
    const groupKey = query.group_key || undefined;
    const cursor = query.cursor || undefined;
    if (cursor && !groupKey) {
      sendJson(res, 400, { error: "group_key is required with cursor" });
      return;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.source) {
      conditions.push("c.source = ?");
      params.push(query.source);
    }
    if (query.starred === "true" || query.starred === "1") {
      conditions.push("c.starred = 1");
    } else if (query.starred === "false" || query.starred === "0") {
      conditions.push("c.starred = 0");
    }

    const searchNeedle = (query.search ?? "").trim();
    const fullTextSearch = query.full_text === "true" || query.full_text === "1";
    if (searchNeedle && !fullTextSearch) {
      conditions.push("c.title LIKE ?");
      params.push(`%${searchNeedle}%`);
    }
    const minBlocks = parseInt(query.min_blocks || "", 10);
    if (Number.isFinite(minBlocks) && minBlocks > 0) {
      conditions.push("c.block_count >= ?");
      params.push(minBlocks);
    }
    const excludeSubagents = query.exclude_subagents === "true" || query.exclude_subagents === "1";
    if (excludeSubagents) {
      conditions.push("c.parent_conversation_id IS NULL");
      conditions.push("(c.project_path IS NULL OR c.project_path != 'subagents')");
      conditions.push("LOWER(c.source_path) NOT LIKE '%/subagents/%'");
      conditions.push("LOWER(c.title) NOT LIKE 'you are a subagent%'");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sort: ConversationSidebarSort = query.sort === "block_count" ? "block_count" : "started_at";
    const querySignature = createHash("sha256").update(JSON.stringify({
      source: query.source || null,
      starred: query.starred || null,
      search: searchNeedle,
      full_text: fullTextSearch,
      min_blocks: Number.isFinite(minBlocks) && minBlocks > 0 ? minBlocks : null,
      exclude_subagents: excludeSubagents,
      project_ids: [...requestedProjectIds].sort(),
      sort,
    })).digest("base64url");

    let rows = db.prepare(`SELECT c.* FROM conversations c ${where}`).all(...params) as ConversationRow[];
    if (searchNeedle && fullTextSearch && rows.length > 0) {
      const searched = await getConversationSearchCache(db).search({
        conversationIds: rows.map((row) => row.id),
        needle: searchNeedle,
        limit: rows.length,
      });
      const matching = new Set(searched.matches.map((match) => match.conversation_id));
      rows = rows.filter((row) => matching.has(row.id));
    }
    try {
      const groups = buildConversationSidebar({
        rows,
        sort,
        querySignature,
        limit,
        groupKey,
        cursor,
        projects,
        requestedProjectIds,
      });
      if (groupKey && groups.length === 0) {
        sendJson(res, 400, { error: "Unknown conversation sidebar group_key" });
        return;
      }
      sendJson(res, 200, {
        groups: groups.map((group) => ({
          key: group.key,
          kind: group.kind,
          label: group.label,
          ...(group.project_id ? { project_id: group.project_id } : {}),
          ...(group.project_key ? { project_key: group.project_key } : {}),
          total: group.total,
          conversations: group.rows.map((row) => mapSidebarConversation(
            row,
            fullTextSearch,
            sessionManager,
          )),
          next_cursor: group.next_cursor,
        })),
        limit,
      });
    } catch (error) {
      if (error instanceof ConversationSidebarCursorError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
  }, { fileRpc: "allow" });

  // --- Parameterized routes ---

  // GET /api/conversations — List with pagination, filtering, sorting
  // Query params:
  //   ?exclude_subagents=true — hide conversations that have a parent (sub-agents)
  //   ?group=true — same as exclude_subagents but also includes children_count on parents
  //   ?parent_id=<id> — list only children of a specific parent conversation
  server.get("/api/conversations", async (req, res) => {
    const query = req.query ?? {};
    const page = Math.max(1, parseInt(query.page || "1", 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || "50", 10) || 50));
    const queryOffset = parseInt(query.offset || "", 10);
    const offset = Number.isFinite(queryOffset) && queryOffset >= 0
      ? queryOffset
      : (page - 1) * limit;

    const groupMode = query.group === "true" || query.group === "1";
    const excludeSubagents = groupMode || query.exclude_subagents === "true" || query.exclude_subagents === "1";
    const parentIdFilter = query.parent_id || null;

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Filter by source
    if (query.source) {
      conditions.push("c.source = ?");
      params.push(query.source);
    }

    // Filter by starred
    if (query.starred === "true" || query.starred === "1") {
      conditions.push("c.starred = 1");
    } else if (query.starred === "false" || query.starred === "0") {
      conditions.push("c.starred = 0");
    }

    if (query.tag) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?)");
      params.push(query.tag);
    }

    const searchNeedle = (query.search ?? "").trim();
    const fullTextSearch = query.full_text === "true" || query.full_text === "1";

    // Title mode remains the cheap metadata filter. Full mode resolves exact
    // source-verified content matches below, through the disposable cache.
    if (searchNeedle && !fullTextSearch) {
      conditions.push("c.title LIKE ?");
      params.push(`%${searchNeedle}%`);
    }

    const minBlocks = parseInt(query.min_blocks || "", 10);
    if (Number.isFinite(minBlocks) && minBlocks > 0) {
      conditions.push("c.block_count >= ?");
      params.push(minBlocks);
    }

    if (query.session_id) {
      conditions.push("c.session_id = ?");
      params.push(query.session_id);
    }

    const since = parseSinceQuery(query.since);
    if (since) {
      conditions.push("c.started_at >= ?");
      params.push(since);
    }

    // Filter by branch
    if (query.branch) {
      conditions.push("c.branch = ?");
      params.push(query.branch);
    }

    // Filter by model
    if (query.model) {
      conditions.push("c.model LIKE ?");
      params.push(`%${query.model}%`);
    }

    // Sub-agent filtering — Bug: d0759d1
    if (parentIdFilter) {
      // List children of a specific parent
      conditions.push("c.parent_conversation_id = ?");
      params.push(parentIdFilter);
    } else if (excludeSubagents) {
      // Hide sub-agent conversations from the main list
      conditions.push("c.parent_conversation_id IS NULL");
      conditions.push("(c.project_path IS NULL OR c.project_path != 'subagents')");
      conditions.push("LOWER(c.source_path) NOT LIKE '%/subagents/%'");
      conditions.push("LOWER(c.title) NOT LIKE 'you are a subagent%'");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Sort
    const sortField = query.sort || "started_at";
    const sortOrder = query.order === "asc" ? "ASC" : "DESC";
    const allowedSorts = new Set(["started_at", "ended_at", "title", "block_count", "created_at", "updated_at", "source"]);
    const safeSortField = allowedSorts.has(sortField) ? sortField : "started_at";

    if (searchNeedle && fullTextSearch) {
      const eligible = db.prepare(
        `SELECT c.id FROM conversations c ${where} ORDER BY c.${safeSortField} ${sortOrder}`,
      ).all(...params) as Array<{ id: string }>;
      const searched = await getConversationSearchCache(db).search({
        conversationIds: eligible.map((row) => row.id),
        needle: searchNeedle,
        limit: eligible.length,
      });
      const ids = searched.matches.map((match) => match.conversation_id);
      const pageIds = ids.slice(offset, offset + limit);
      const selectCols = groupMode
        ? `c.*, (SELECT COUNT(*) FROM conversations ch WHERE ch.parent_conversation_id = c.id) AS children_count`
        : `c.*`;
      const rows = pageIds.length === 0
        ? []
        : db.prepare(
          `SELECT ${selectCols} FROM conversations c
           WHERE c.id IN (${pageIds.map(() => "?").join(",")})
           ORDER BY c.${safeSortField} ${sortOrder}`,
        ).all(...pageIds) as ConversationRow[];
      const pageOrder = new Map(pageIds.map((id, index) => [id, index]));
      rows.sort((left, right) => (pageOrder.get(left.id) ?? 0) - (pageOrder.get(right.id) ?? 0));
      sendJson(res, 200, {
        conversations: rows.map((row) => mapSearchConversation(row, sessionManager)),
        total: ids.length,
        page,
        limit,
        pages: Math.ceil(ids.length / limit),
        search_metrics: searched.metrics,
      });
      return;
    }

    // Count total
    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM conversations c ${where}`)
      .get(...params) as { total: number };

    // Fetch page — include children_count via subquery when grouping
    const selectCols = groupMode
      ? `c.*, (SELECT COUNT(*) FROM conversations ch WHERE ch.parent_conversation_id = c.id) AS children_count`
      : `c.*`;

    const rows = db
      .prepare(
        `SELECT ${selectCols} FROM conversations c ${where} ORDER BY c.${safeSortField} ${sortOrder} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as ConversationRow[];

    sendJson(res, 200, {
      conversations: rows.map((row) => mapConversation(row, sessionManager)),
      total: countRow.total,
      page,
      limit,
      pages: Math.ceil(countRow.total / limit),
    });
  }, { fileRpc: "allow" });

  // GET /api/conversations/search — Search the normalized conversation index.
  server.get("/api/conversations/search", async (req, res) => {
    const query = req.query ?? {};
    const needle = (query.q || query.query || "").trim().toLowerCase();
    if (!needle) {
      sendJson(res, 400, { error: "Missing search query" });
      return;
    }

    const limit = Math.min(100, Math.max(1, parseInt(query.limit || "20", 10) || 20));
    const source = sourceFromQuery(query.source || query.provider);
    const since = parseSinceQuery(query.since);
    const titleOnly = query.title === "true" || query.title === "1";
    const blockType = blockTypeFromRole(query.role);

    const convConditions: string[] = ["1=1"];
    const convParams: unknown[] = [];
    if (source) {
      convConditions.push("source = ?");
      convParams.push(source);
    }
    if (since) {
      convConditions.push("started_at >= ?");
      convParams.push(since);
    }

    const conversations = db
      .prepare(
        `SELECT * FROM conversations WHERE ${convConditions.join(" AND ")} ORDER BY started_at DESC`,
      )
      .all(...convParams) as ConversationRow[];

    const results: Array<{
      conversation: ReturnType<typeof mapSearchConversation>;
      block: Omit<ReturnType<typeof mapBlock>, "content"> & { content: string } | null;
      snippet: string;
    }> = [];

    const makeSnippet = (text: string): string | null => {
      const index = text.toLowerCase().indexOf(needle);
      if (index < 0) return null;
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + needle.length + 80);
      const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
      return `${start > 0 ? "..." : ""}${snippet}${end < text.length ? "..." : ""}`;
    };

    if (titleOnly) {
      for (const conversation of conversations) {
        if (results.length >= limit) break;
        const snippet = makeSnippet(maskUnverifiedCandidates(conversation.title || "").text);
        if (snippet) {
          results.push({ conversation: mapSearchConversation(conversation, sessionManager), block: null, snippet });
        }
      }
      sendJson(res, 200, { results, total: results.length, limit });
      return;
    }

    const searched = await getConversationSearchCache(db).search({
      conversationIds: conversations.map((conversation) => conversation.id),
      needle,
      blockType,
      limit,
    });
    const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    for (const match of searched.matches) {
      const conversation = conversationsById.get(match.conversation_id);
      if (!conversation) continue;
      const read = await sourceReader.readBlock(match.block_id);
      if (read.status !== "source" && read.status !== "legacy") continue;
      const block = read.value;
      results.push({
        conversation: mapSearchConversation(conversation, sessionManager),
        // Search responses carry only structural block metadata plus the
        // verified masked snippet. Returning the complete durable body here
        // would duplicate the detail route and could bypass the cache's
        // fail-closed masking boundary for legacy fixtures.
        block: { ...block, content: "" },
        snippet: match.snippet,
      });
    }

    sendJson(res, 200, {
      results,
      total: results.length,
      limit,
      search_metrics: searched.metrics,
    });
  }, { fileRpc: "allow" });

  // GET /api/conversations/:id — bounded, indexed conversation-position window.
  server.get("/api/conversations/:id", async (req, res) => {
    const requestedRef = req.params.id;
    if (!requestedRef) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    let id: string;
    try {
      id = (await ensureExactConversationFresh(db, requestedRef)).conversationId;
    } catch (error) {
      if (sendFreshnessError(res, error)) return;
      sendJson(res, 503, { error: "freshness_error", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    const conv = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    const query = req.query ?? {};
    const useSourceReader = (query.source_backed !== "false" && query.source_backed !== "0")
      || conversationRequiresSourceReader(db, id);
    const requestedLimit = Math.max(1, parseInt(query.limit || "160", 10) || 160);
    const limit = Math.min(500, requestedLimit);
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
    const resolved = resolvePositionTarget(db, id, targetKind, requestedValue);
    if (!resolved) {
      sendJson(res, 404, { error: `${targetKind === "turn" ? "Turn" : targetKind === "block" ? "Block" : "Position"} anchor not found` });
      return;
    }

    const total = (db.prepare(
      "SELECT COUNT(*) AS total FROM conversation_blocks WHERE conversation_id = ?",
    ).get(id) as { total: number }).total;
    let blocks: BlockRow[] = [];
    if (resolved.block) {
      if (targetKind === "initial" || targetKind === "latest") {
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

    // Fetch sub-agent (child) conversations — Bug: d0759d1
    const children = db
      .prepare(
        `SELECT id, title, block_count, started_at, ended_at, source, model,
                agent_id, is_sidechain, source_mtime, updated_at
         FROM conversations
         WHERE parent_conversation_id = ?
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

    const startPosition = blocks[0]?.position ?? null;
    const endPosition = blocks[blocks.length - 1]?.position ?? null;
    let readableBlocks: Array<BlockRow | SourceBackedConversationBlock> = blocks;
    let bodySource: "source" | "legacy" = "legacy";
    if (useSourceReader) {
      const offset = startPosition === null ? 0 : (db.prepare(
        "SELECT COUNT(*) AS total FROM conversation_blocks WHERE conversation_id = ? AND position < ?",
      ).get(id, startPosition) as { total: number }).total;
      const sourcePage = await sourceReader.readPage(id, { offset, limit });
      if (sourcePage.status !== "source" && sourcePage.status !== "legacy") {
        sendJson(res, sourcePage.status === "not_found" ? 404 : 409, {
          error: sourcePage.reason,
          status: sourcePage.status,
        });
        return;
      }
      readableBlocks = sourcePage.value.blocks;
      bodySource = sourcePage.status;
    }
    const mapped = useSourceReader
      ? mapConversation(maskSourceBackedConversationRow(conv), sessionManager)
      : mapConversation(conv, sessionManager);
    mapped.children_count = children.length;
    const hasBefore = startPosition !== null && Boolean(db.prepare(
      "SELECT 1 FROM conversation_blocks WHERE conversation_id = ? AND position < ? LIMIT 1",
    ).get(id, startPosition));
    const afterCount = endPosition === null ? 0 : (db.prepare(
      "SELECT COUNT(*) AS total FROM conversation_blocks WHERE conversation_id = ? AND position > ?",
    ).get(id, endPosition) as { total: number }).total;

    sendJson(res, 200, {
      conversation: mapped,
      body_source: bodySource,
      children: childrenWithDuration,
      parent: parent ?? null,
      revision: conv.block_count,
      total,
      target: {
        kind: targetKind,
        requested_value: requestedValue,
        position: resolved.block?.position ?? null,
        block_id: resolved.block?.id ?? null,
        turn_id: resolved.turnId,
      },
      window: {
        start_position: startPosition,
        end_position: endPosition,
        has_before: hasBefore,
        has_after: afterCount > 0,
        after_count: afterCount,
        limit,
      },
      blocks: readableBlocks.map(mapReadableBlock),
    });
  }, { fileRpc: "allow" });

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
  }, { fileRpc: "allow" });

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
  }), { fileRpc: "deny" });

  // POST /api/conversations/:id/resume — Resume a conversation from a specific message
  // Bug: 40f0298 — DAG branching: create a Console session resuming at a message
  server.post("/api/conversations/:id/resume", operatorOnlyManagedSessionRoute(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    const body = readBody<{
      message_dag_uuid: string;
      label?: string;
      model?: string;
      force?: boolean;
      fork?: boolean;
    }>(req);
    if (!body.message_dag_uuid) {
      sendJson(res, 400, { error: "Missing message_dag_uuid" });
      return;
    }

    const conv = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    try {
      if (!sessionManager) {
        sendJson(res, 501, { error: "SessionManager not available" });
        return;
      }

      const attachState = deriveConversationAttachState(conv, db, sessionManager);
      if (body.fork === true) {
        if (conv.source !== "claude_code") {
          sendJson(res, 501, {
            error: "fork_unsupported",
            message: "Fork is not supported for this provider.",
            attach_state: attachState,
          });
          return;
        }
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        if (typeof sdk.forkSession !== "function") {
          sendJson(res, 501, {
            error: "fork_unsupported",
            message: "SDK does not support forkSession.",
            attach_state: attachState,
          });
          return;
        }
        const result = await sdk.forkSession(conv.session_id, {
          upToMessageId: body.message_dag_uuid,
        });
        sendJson(res, 200, { session_id: result.sessionId, attach_state: attachState });
        return;
      }

      if (attachState.kind === "live-owned" && attachState.console_session_id) {
        sendJson(res, 200, {
          console_session_id: attachState.console_session_id,
          attach_state: attachState,
        });
        return;
      }

      if (attachState.kind === "live-external" && body.force !== true) {
        sendJson(res, 409, {
          error: "resume_conflict",
          reason: attachState.reason,
          message: "This conversation appears live outside Mandible; resume is blocked to avoid interleaving transcripts.",
          attach_state: attachState,
        });
        return;
      }

      if (attachState.kind === "historical") {
        sendJson(res, 409, {
          error: "resume_unavailable",
          reason: attachState.reason,
          message: "This conversation is historical and cannot be resumed by the current provider.",
          attach_state: attachState,
        });
        return;
      }

      const args: string[] = [];
      const model = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : conv.model;
      if (model) {
        args.push("--model", model);
      }

      const command = conv.source === "codex"
        ? "codex"
        : conv.source === "gemini"
          ? "gemini"
          : "claude";
      const backendType = command === "claude" ? "sdk" : command === "gemini" ? "acp" : "spawn";

      const newSession = sessionManager.create({
        label: body.label || conv.title || "Resumed conversation",
        command,
        args,
        backend_type: backendType,
        provider_session_id: conv.session_id,
        resume_at_message: command === "claude" ? body.message_dag_uuid : null,
        cwd: conv.cwd ?? undefined,
      });

      sendJson(res, 200, {
        console_session_id: newSession.id,
        attach_state: {
          ...attachState,
          kind: "live-owned",
          reason: "mandible-owned",
          resumable: true,
          console_session_id: newSession.id,
          checked_at: Date.now(),
        },
      });
    } catch (error) {
      sendJson(res, 500, {
        error: "Resume failed",
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }), { fileRpc: "deny" });

  // GET /api/conversations/:id/blocks — Blocks with type filtering and pagination
  server.get("/api/conversations/:id/blocks", async (req, res) => {
    const requestedRef = req.params.id;
    if (!requestedRef) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    let id: string;
    try {
      id = (await ensureExactConversationFresh(db, requestedRef)).conversationId;
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
  }, { fileRpc: "allow" });

  // PATCH /api/conversations/:id — Update durable Mandible-owned metadata.
  server.patch("/api/conversations/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    const body = readBody<Record<string, unknown>>(req);
    const allowed = new Set(["starred", "tags", "tags_add", "tags_remove", "notes", "notes_append"]);
    const supplied = Object.keys(body);
    if (supplied.length === 0 || supplied.some((key) => !allowed.has(key))) {
      sendJson(res, 400, { error: "No updates provided" });
      return;
    }

    try {
      if ("starred" in body && body.starred !== true && body.starred !== false && body.starred !== 0 && body.starred !== 1) {
        throw new Error("starred must be a boolean");
      }
      if ("notes" in body && body.notes !== null && typeof body.notes !== "string") {
        throw new Error("notes must be a string or null");
      }
      if ("notes_append" in body && (typeof body.notes_append !== "string" || !body.notes_append.trim())) {
        throw new Error("notes_append must be a non-empty string");
      }
      // The read-modify-write is one IMMEDIATE transaction so concurrent tag
      // or comment appends serialize instead of silently overwriting one another.
      const result = db.transaction(() => {
        const current = db.prepare("SELECT * FROM conversations WHERE id = ?")
          .get(id) as ConversationRow | undefined;
        if (!current) return null;
        let tags = canonicalizeTags(JSON.parse(current.tags), "stored tags");
        if ("tags" in body) tags = canonicalizeTags(body.tags, "tags");
        if ("tags_add" in body) tags = canonicalizeTags([...tags, ...canonicalizeTags(body.tags_add, "tags_add")], "tags");
        if ("tags_remove" in body) {
          const remove = new Set(canonicalizeTags(body.tags_remove, "tags_remove"));
          tags = tags.filter((tag) => !remove.has(tag));
        }

        const changedFields: string[] = [];
        const nextStarred = "starred" in body ? (body.starred === true || body.starred === 1 ? 1 : 0) : current.starred;
        if (nextStarred !== current.starred) changedFields.push("starred");
        const nextTags = JSON.stringify(tags);
        if (nextTags !== current.tags) changedFields.push("tags");
        let nextNotes = current.notes;
        if ("notes" in body) nextNotes = body.notes === null ? null : (body.notes as string).trim() || null;
        if ("notes_append" in body) {
          const append = (body.notes_append as string).trim();
          nextNotes = nextNotes?.trim() ? `${nextNotes.trim()}\n\n${append}` : append;
        }
        if (nextNotes !== current.notes) changedFields.push("notes");

        db.prepare(`UPDATE conversations
          SET starred = ?, tags = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(nextStarred, nextTags, nextNotes, id);
        const updated = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow;
        return { updated, changedFields };
      }).immediate();
      if (!result) {
        sendJson(res, 404, { error: "Conversation not found" });
        return;
      }
      broadcast("conversation:updated", { id, updates: result.changedFields });
      sendJson(res, 200, mapConversation(result.updated, sessionManager));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid metadata update" });
    }
  }, { fileRpc: "allow" });

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
      id = (await ensureExactConversationFresh(db, requestedRef)).conversationId;
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
      .prepare("SELECT * FROM conversations WHERE id = ?")
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
  }, { fileRpc: "allow" });

}
