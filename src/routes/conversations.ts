// API routes for the chat log / conversation system.

import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { broadcast } from "../sse.js";
import { decompressContent, decompressContentAsync } from "../compression.js";
import { deriveConversationAttachState } from "../conversation-attach-state.js";
import { operatorOnlyManagedSessionRoute } from "../client-auth/authz.js";
import { triggerFullIngest } from "../ingestion.js";
import { transformContent } from "../transform.js";
import type { SessionManager } from "../session-manager.js";
import type { RouteRegistrar } from "../server.js";
import { readBody, sendJson } from "./http.js";

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
  label: string | null;
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
  return {
    ...row,
    starred: row.starred === 1,
    parent_conversation_id: row.parent_conversation_id ?? null,
    is_sidechain: row.is_sidechain === 1,
    agent_id: row.agent_id ?? null,
    children_count: row.children_count ?? 0,
    attach_state: deriveConversationAttachState(row, getDb(), sessionManager),
  };
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

  // --- Parameterized routes ---

  // GET /api/conversations — List with pagination, filtering, sorting
  // Query params:
  //   ?exclude_subagents=true — hide conversations that have a parent (sub-agents)
  //   ?group=true — same as exclude_subagents but also includes children_count on parents
  //   ?parent_id=<id> — list only children of a specific parent conversation
  server.get("/api/conversations", (req, res) => {
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

    // Search in title
    if (query.search) {
      conditions.push("c.title LIKE ?");
      params.push(`%${query.search}%`);
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
  server.get("/api/conversations/search", (req, res) => {
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
      conversation: ReturnType<typeof mapConversation>;
      block: ReturnType<typeof mapBlock> | null;
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

    for (const conversation of conversations) {
      if (results.length >= limit) break;
      if (titleOnly) {
        const snippet = makeSnippet(conversation.title || "");
        if (snippet) {
          results.push({ conversation: mapConversation(conversation, sessionManager), block: null, snippet });
        }
        continue;
      }

      const blockConditions = ["conversation_id = ?"];
      const blockParams: unknown[] = [conversation.id];
      if (blockType) {
        blockConditions.push("type = ?");
        blockParams.push(blockType);
      }
      const blocks = db
        .prepare(
          `SELECT * FROM conversation_blocks WHERE ${blockConditions.join(" AND ")} ORDER BY position ASC`,
        )
        .all(...blockParams) as BlockRow[];

      for (const block of blocks) {
        const mapped = mapBlock(block);
        const snippet = makeSnippet(mapped.content);
        if (snippet) {
          results.push({ conversation: mapConversation(conversation, sessionManager), block: mapped, snippet });
          break;
        }
      }
    }

    sendJson(res, 200, { results, total: results.length, limit });
  }, { fileRpc: "allow" });

  // GET /api/conversations/:id — Full conversation with blocks + children summary
  // Bug: 40f0298 — optional ?leaf=<dag_uuid> param for DAG path resolution
  server.get("/api/conversations/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
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
    const leafDagUuid = query.leaf || null;

    let blocks: BlockRow[];

    if (leafDagUuid) {
      // DAG path resolution: walk backward from leaf to root via dag_parent_uuid
      const allBlocks = db
        .prepare("SELECT * FROM conversation_blocks WHERE conversation_id = ? ORDER BY position ASC")
        .all(id) as BlockRow[];

      // Index blocks by dag_uuid for efficient lookup
      const blocksByDagUuid = new Map<string, BlockRow[]>();
      for (const block of allBlocks) {
        if (block.dag_uuid) {
          const group = blocksByDagUuid.get(block.dag_uuid);
          if (group) {
            group.push(block);
          } else {
            blocksByDagUuid.set(block.dag_uuid, [block]);
          }
        }
      }

      // Walk backward from leaf
      const pathGroups: BlockRow[][] = [];
      let currentUuid: string | null = leafDagUuid;
      const visited = new Set<string>();

      while (currentUuid && !visited.has(currentUuid)) {
        visited.add(currentUuid);
        const group = blocksByDagUuid.get(currentUuid);
        if (!group || group.length === 0) break;
        pathGroups.push(group);
        // All blocks in a dag_uuid group share the same dag_parent_uuid
        currentUuid = group[0].dag_parent_uuid;
      }

      // Reverse to get root-first order, then flatten
      pathGroups.reverse();
      blocks = pathGroups.flat();

      // Fallback: if the leaf dag_uuid didn't match any block (e.g., old conversation
      // without dag_uuid data), return all blocks ordered by position.
      if (blocks.length === 0) {
        blocks = allBlocks;
      }
    } else {
      blocks = db
        .prepare("SELECT * FROM conversation_blocks WHERE conversation_id = ? ORDER BY position ASC")
        .all(id) as BlockRow[];
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

    const mapped = mapConversation(conv, sessionManager);
    mapped.children_count = children.length;

    sendJson(res, 200, {
      conversation: mapped,
      blocks: blocks.map(mapBlock),
      children: childrenWithDuration,
      parent: parent ?? null,
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

    // Find fork points: dag_parent_uuid values with multiple distinct dag_uuid children
    const forkPoints = db
      .prepare(
        `SELECT dag_parent_uuid, COUNT(DISTINCT dag_uuid) as branch_count
         FROM conversation_blocks
         WHERE conversation_id = ? AND dag_parent_uuid IS NOT NULL
         GROUP BY dag_parent_uuid
         HAVING COUNT(DISTINCT dag_uuid) > 1`
      )
      .all(id) as Array<{ dag_parent_uuid: string; branch_count: number }>;

    const forkParentUuids = new Set(forkPoints.map((fp) => fp.dag_parent_uuid));
    const childRows = db
      .prepare(
        `SELECT dag_parent_uuid, dag_uuid
         FROM conversation_blocks
         WHERE conversation_id = ? AND dag_parent_uuid IS NOT NULL AND dag_uuid IS NOT NULL
         GROUP BY dag_parent_uuid, dag_uuid
         ORDER BY MIN(position) ASC`,
      )
      .all(id) as Array<{ dag_parent_uuid: string; dag_uuid: string }>;

    const previewRows = db
      .prepare(
        `SELECT dag_parent_uuid, dag_uuid, content, compressed
         FROM (
           SELECT dag_parent_uuid, dag_uuid, content, compressed,
                  ROW_NUMBER() OVER (
                    PARTITION BY dag_parent_uuid, dag_uuid
                    ORDER BY position ASC
                  ) AS rn
             FROM conversation_blocks
            WHERE conversation_id = ?
              AND dag_parent_uuid IS NOT NULL
              AND dag_uuid IS NOT NULL
              AND type IN ('assistant_message', 'assistant')
         )
         WHERE rn = 1`,
      )
      .all(id) as Array<{
        dag_parent_uuid: string;
        dag_uuid: string;
        content: Buffer | string;
        compressed: number;
      }>;

    const countRows = db
      .prepare(
        `SELECT dag_uuid, COUNT(*) as cnt
         FROM conversation_blocks
         WHERE conversation_id = ? AND dag_uuid IS NOT NULL
         GROUP BY dag_uuid`,
      )
      .all(id) as Array<{ dag_uuid: string; cnt: number }>;

    const previews = new Map<string, string>();
    await Promise.all(previewRows
      .filter((row) => forkParentUuids.has(row.dag_parent_uuid))
      .map(async (row) => {
        const text = await decompressContentAsync(row.content, row.compressed === 1);
        previews.set(`${row.dag_parent_uuid}\0${row.dag_uuid}`, text.slice(0, 60));
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
  server.get("/api/conversations/:id/blocks", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
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

    const conditions: string[] = ["conversation_id = ?"];
    const params: unknown[] = [id];

    // Filter by block type(s)
    if (query.type) {
      const types = query.type.split(",").map((t) => t.trim()).filter(Boolean);
      if (types.length > 0) {
        conditions.push(`type IN (${types.map(() => "?").join(",")})`);
        params.push(...types);
      }
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM conversation_blocks ${where}`)
      .get(...params) as { total: number };

    const blocks = db
      .prepare(
        `SELECT * FROM conversation_blocks ${where} ORDER BY position ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as BlockRow[];

    sendJson(res, 200, {
      blocks: blocks.map(mapBlock),
      total: countRow.total,
      offset,
      page: Math.floor(offset / limit) + 1,
      limit,
      requested_limit: requestedLimit,
      cap: 500,
      pages: Math.ceil(countRow.total / limit),
      truncated: offset + blocks.length < countRow.total,
    });
  }, { fileRpc: "allow" });

  // PATCH /api/conversations/:id — Update starred/label/notes
  server.patch("/api/conversations/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    const body = readBody<Record<string, unknown>>(req);
    const updates: string[] = [];
    const params: Record<string, unknown> = { id };

    if ("starred" in body) {
      const starred = body.starred === true || body.starred === 1;
      updates.push("starred = @starred");
      params.starred = starred ? 1 : 0;
    }

    if ("label" in body) {
      if (body.label === null) {
        updates.push("label = @label");
        params.label = null;
      } else if (typeof body.label === "string") {
        updates.push("label = @label");
        params.label = body.label.trim() || null;
      } else {
        sendJson(res, 400, { error: "Invalid label" });
        return;
      }
    }

    if ("notes" in body) {
      if (body.notes === null) {
        updates.push("notes = @notes");
        params.notes = null;
      } else if (typeof body.notes === "string") {
        updates.push("notes = @notes");
        params.notes = body.notes.trim() || null;
      } else {
        sendJson(res, 400, { error: "Invalid notes" });
        return;
      }
    }

    if (updates.length === 0) {
      sendJson(res, 400, { error: "No updates provided" });
      return;
    }

    updates.push("updated_at = datetime('now')");

    const result = db
      .prepare(`UPDATE conversations SET ${updates.join(", ")} WHERE id = @id`)
      .run(params);

    if (result.changes === 0) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    // Broadcast update
    broadcast("conversation:updated", { id, updates: Object.keys(body) });

    sendJson(res, 200, { ok: true });
  }, { fileRpc: "deny" });

  // POST /api/conversations/:id/export — Export selected blocks to markdown/MDX/JSON
  server.post("/api/conversations/:id/export", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    const body = readBody<{
      format?: "markdown" | "mdx" | "json";
      block_types?: string[];
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

    const rawBlocks = db
      .prepare("SELECT * FROM conversation_blocks WHERE conversation_id = ? ORDER BY position ASC")
      .all(id) as BlockRow[];

    // Bug: e5a945d — decompress before passing to export helpers
    const blocks = decompressBlocks(rawBlocks);

    const blockTypes = body.block_types ? new Set(body.block_types) : undefined;

    let output: string;
    let contentType: string;

    if (format === "mdx") {
      output = exportToMdx(conv, blocks, blockTypes);
      contentType = "text/mdx";
    } else if (format === "json") {
      output = exportToJson(conv, blocks, blockTypes);
      contentType = "application/json";
    } else {
      output = exportToMarkdown(conv, blocks, blockTypes);
      contentType = "text/markdown";
    }

    sendJson(res, 200, {
      format,
      content_type: contentType,
      content: output,
      block_count: blockTypes
        ? blocks.filter((b) => blockTypes.has(b.type)).length
        : blocks.length,
    });
  }, { fileRpc: "deny" });

}
