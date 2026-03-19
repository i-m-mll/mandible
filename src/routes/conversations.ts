// API routes for the chat log / conversation system.

import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { broadcast } from "../sse.js";
import { decompressContent } from "../compression.js";
import { triggerFullIngest } from "../ingestion.js";
import { transformContent } from "../transform.js";
import type { SessionManager } from "../session-manager.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";

function readBody<T>(req: RequestLike): T {
  return (req.body ?? {}) as T;
}

function sendJson(res: ResponseLike, code: number, payload: unknown): void {
  res.status(code).json(payload);
}

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

function mapConversation(row: ConversationRow) {
  return {
    ...row,
    starred: row.starred === 1,
    parent_conversation_id: row.parent_conversation_id ?? null,
    children_count: row.children_count ?? 0,
  };
}

function mapBlock(row: BlockRow) {
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    // ignore
  }
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
    metadata,
    dag_uuid: row.dag_uuid ?? null,
    dag_parent_uuid: row.dag_parent_uuid ?? null,
  };
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
  });

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
  });

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
  });

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
    const offset = (page - 1) * limit;

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

    if (query.session_id) {
      conditions.push("c.session_id = ?");
      params.push(query.session_id);
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
      conversations: rows.map(mapConversation),
      total: countRow.total,
      page,
      limit,
      pages: Math.ceil(countRow.total / limit),
    });
  });

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
    } else {
      blocks = db
        .prepare("SELECT * FROM conversation_blocks WHERE conversation_id = ? ORDER BY position ASC")
        .all(id) as BlockRow[];
    }

    // Fetch sub-agent (child) conversations — Bug: d0759d1
    const children = db
      .prepare(
        `SELECT id, title, block_count, started_at, ended_at, source, model
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
      return { ...child, duration_seconds };
    });

    const mapped = mapConversation(conv);
    mapped.children_count = children.length;

    sendJson(res, 200, {
      conversation: mapped,
      blocks: blocks.map(mapBlock),
      children: childrenWithDuration,
    });
  });

  // GET /api/conversations/:id/forks — Fork points in the conversation DAG
  // Bug: 40f0298 — DAG branching: identify points where the conversation branches
  server.get("/api/conversations/:id/forks", (req, res) => {
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

    const forks = forkPoints.map((fp) => {
      // Get distinct child dag_uuids for this fork point
      const childUuids = db
        .prepare(
          `SELECT DISTINCT dag_uuid
           FROM conversation_blocks
           WHERE conversation_id = ? AND dag_parent_uuid = ?`
        )
        .all(id, fp.dag_parent_uuid) as Array<{ dag_uuid: string }>;

      const branches = childUuids.map((child) => {
        // Get first assistant_message or assistant-type block for preview text
        const previewBlock = db
          .prepare(
            `SELECT content, compressed
             FROM conversation_blocks
             WHERE conversation_id = ? AND dag_uuid = ? AND type IN ('assistant_message', 'assistant')
             ORDER BY position ASC
             LIMIT 1`
          )
          .get(id, child.dag_uuid) as { content: Buffer | string; compressed: number } | undefined;

        let first_text = "";
        if (previewBlock) {
          const text = decompressContent(previewBlock.content, previewBlock.compressed === 1);
          first_text = text.slice(0, 60);
        }

        // Count blocks with this dag_uuid (simple approximation of branch size)
        const countRow = db
          .prepare(
            `SELECT COUNT(*) as cnt
             FROM conversation_blocks
             WHERE conversation_id = ? AND dag_uuid = ?`
          )
          .get(id, child.dag_uuid) as { cnt: number };

        return {
          dag_uuid: child.dag_uuid,
          first_text,
          block_count: countRow.cnt,
        };
      });

      return {
        parent_dag_uuid: fp.dag_parent_uuid,
        branches,
      };
    });

    sendJson(res, 200, { forks });
  });

  // POST /api/conversations/:id/fork — Fork a conversation at a specific message
  // Bug: 40f0298 — DAG branching: create a new session by forking at a message
  server.post("/api/conversations/:id/fork", async (req, res) => {
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
      .get(id) as { session_id: string } | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
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
  });

  // POST /api/conversations/:id/resume — Resume a conversation from a specific message
  // Bug: 40f0298 — DAG branching: create a Console session resuming at a message
  server.post("/api/conversations/:id/resume", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing conversation id" });
      return;
    }

    const body = readBody<{ message_dag_uuid: string; label?: string }>(req);
    if (!body.message_dag_uuid) {
      sendJson(res, 400, { error: "Missing message_dag_uuid" });
      return;
    }

    const conv = db
      .prepare("SELECT session_id, title FROM conversations WHERE id = ?")
      .get(id) as { session_id: string; title: string } | undefined;
    if (!conv) {
      sendJson(res, 404, { error: "Conversation not found" });
      return;
    }

    try {
      if (!sessionManager) {
        sendJson(res, 501, { error: "SessionManager not available" });
        return;
      }

      const newSession = sessionManager.create({
        label: body.label || conv.title || "Resumed conversation",
        command: "claude",
        backend_type: "sdk",
        provider_session_id: conv.session_id,
        resume_at_message: body.message_dag_uuid,
      });

      sendJson(res, 200, { console_session_id: newSession.id });
    } catch (error) {
      sendJson(res, 500, {
        error: "Resume failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

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
    const limit = Math.min(500, Math.max(1, parseInt(query.limit || "100", 10) || 100));
    const offset = (page - 1) * limit;

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
      page,
      limit,
      pages: Math.ceil(countRow.total / limit),
    });
  });

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
  });

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
  });

}
