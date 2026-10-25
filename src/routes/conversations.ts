import { MAX_ORDERED_SIDEBAR_IDS } from "../host-user-preferences.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import { resolveConversationId } from '../conversations/identity.js';
// API routes for the chat log / conversation system.

import { createHash } from "node:crypto";
import { getDb } from "../db.js";
import { entityRefs, resolveSessionRef } from "../entity-refs.js";
import { sessionAliasIds } from "../session-liveness.js";
import { sessionConversationsSql } from "../session-summary.js";
import { broadcast } from "../sse.js";
import { decompressContent, decompressContentAsync } from "../compression.js";
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
  type ConversationSidebarRow,
  type ConversationSidebarSort,
} from "../conversations/sidebar-projection.js";
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
import type { ConversationExternalNavigation } from "../contracts.js";
import type { ConversationSpawnReceipt } from "../conversation-spawn/types.js";
import { childrenOfConversationSql, listLineageGaps } from "../conversation-lineage.js";
import type { SessionRegistry } from "../registry.js";
import {
  executeConversationExternalNavigation,
  projectConversationExternalNavigation,
  type ExternalNavigationConversation,
} from "../conversation-external-navigation.js";

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
  archived_at?: number | null;
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

function mapConversation(row: ConversationRow, externalNavigation?: ConversationExternalNavigation) {
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
    identity_aliases: (getDb().prepare('SELECT alias_id FROM conversation_identity_aliases WHERE canonical_id = ? ORDER BY alias_id')
      .all(row.id) as { alias_id: string }[]).map((alias) => alias.alias_id),
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
    archived_at: row.archived_at ?? null,
    parent_conversation_id: row.parent_conversation_id ?? null,
    is_sidechain: row.is_sidechain === 1,
    agent_id: row.agent_id ?? null,
    children_count: row.children_count ?? 0,
    ...(externalNavigation ? { external_navigation: externalNavigation } : {}),
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

function mapSearchConversation(row: ConversationRow) {
  return mapConversation(maskSourceBackedConversationRow(row));
}

type ProjectedConversationRow = ConversationRow & {
  canonical_project_id?: string | null;
  canonical_project_key?: string | null;
  canonical_placement_explicit?: number;
  spawn?: ConversationSpawnReceipt;
  spawn_schema_version?: string | null;
  spawn_request_json?: string | null;
  spawn_state?: string | null;
  spawn_attempt_count?: number | null;
  spawn_native_session_id?: string | null;
  spawn_provider_session_id?: string | null;
  spawn_provider_receipt_json?: string | null;
  spawn_error_json?: string | null;
  spawn_created_at?: number | null;
  spawn_updated_at?: number | null;
};

function projectedSpawn(row: ProjectedConversationRow): ConversationSpawnReceipt | undefined {
  if (!row.spawn_schema_version || !row.spawn_request_json || !row.spawn_state
      || row.spawn_attempt_count == null || row.spawn_created_at == null || row.spawn_updated_at == null) {
    return undefined;
  }
  return {
    schema: row.spawn_schema_version as ConversationSpawnReceipt["schema"],
    reservation_id: row.id,
    request: JSON.parse(row.spawn_request_json),
    state: row.spawn_state as ConversationSpawnReceipt["state"],
    attempt_count: row.spawn_attempt_count,
    native_session_id: row.spawn_native_session_id ?? null,
    provider_session_id: row.spawn_provider_session_id ?? null,
    provider_receipt: row.spawn_provider_receipt_json ? JSON.parse(row.spawn_provider_receipt_json) : null,
    error: row.spawn_error_json ? JSON.parse(row.spawn_error_json) : null,
    created_at: row.spawn_created_at,
    updated_at: row.spawn_updated_at,
  };
}

function mapSidebarConversation(
  row: ProjectedConversationRow,
  fullTextSearch: boolean,
) {
  const spawn = row.spawn ?? projectedSpawn(row);
  return {
    ...(fullTextSearch
      ? mapSearchConversation(row)
      : mapConversation(row)),
    canonical_project_id: row.canonical_project_id ?? null,
    canonical_project_key: row.canonical_project_key ?? null,
    ...(spawn ? { spawn } : {}),
  };
}

const SIDEBAR_CONVERSATION_FROM = `FROM conversations c
      LEFT JOIN conversation_archive_states a ON a.conversation_id = c.id
      LEFT JOIN conversation_spawn_requests s ON s.id = COALESCE(
        (SELECT alias_id FROM conversation_identity_aliases WHERE canonical_id = c.id ORDER BY alias_id LIMIT 1), c.id
      ) AND s.schema_version = 'mandible-conversation-spawn-request@3'
      LEFT JOIN ledger_projects p ON p.id = s.project_id`;

function hydrateSidebarConversations(
  db: ReturnType<typeof getDb>,
  ids: readonly string[],
): Map<string, ProjectedConversationRow> {
  if (ids.length === 0) return new Map();
  const rows = db.prepare(`SELECT c.*,
        s.schema_version AS spawn_schema_version, s.request_json AS spawn_request_json,
        s.state AS spawn_state, s.attempt_count AS spawn_attempt_count,
        s.native_session_id AS spawn_native_session_id,
        s.provider_session_id AS spawn_provider_session_id,
        s.provider_receipt_json AS spawn_provider_receipt_json,
        s.error_json AS spawn_error_json, s.created_at AS spawn_created_at,
        s.updated_at AS spawn_updated_at
      ${SIDEBAR_CONVERSATION_FROM}
      WHERE c.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as ProjectedConversationRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

const MAX_SIDEBAR_PROJECTS = 500;
const MAX_SIDEBAR_PROJECT_IDS_LENGTH = 32_768;

function parseSidebarIds(raw: string | undefined, name: string): string[] {
  const maxIds = name === "pinned_ids" ? MAX_ORDERED_SIDEBAR_IDS : MAX_SIDEBAR_PROJECTS;
  const maxLength = name === "pinned_ids" ? MAX_ORDERED_SIDEBAR_IDS * 65 : MAX_SIDEBAR_PROJECT_IDS_LENGTH;
  if (raw === undefined || raw === "") return [];
  if (raw.length > maxLength) {
    throw new Error(`${name} exceeds ${maxLength} characters`);
  }
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => !value)) throw new Error(`${name} contains an empty id`);
  const ids = [...new Set(values)];
  if (ids.length > maxIds) {
    throw new Error(`${name} accepts at most ${maxIds} ids`);
  }
  return ids;
}

function parseSidebarProjectIds(raw: string | undefined): string[] {
  return parseSidebarIds(raw, "project_ids");
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

export function registerConversationRoutes(
  server: RouteRegistrar,
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
  server.get("/api/conversations/lineage-gaps", (req, res) => {
    const query = req.query ?? {};
    const since = parseSinceQuery(query.since);
    const source = sourceFromQuery(query.provider);
    if (source !== null && source !== "claude_code" && source !== "codex" && source !== "gemini") {
      sendJson(res, 400, { error: "provider must be claude, codex, gemini, or all" });
      return;
    }
    sendJson(res, 200, listLineageGaps(db, { since, source }));
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
    const query = req.query ?? {};
    const lifecycle = query.lifecycle || "active";
    if (lifecycle !== "active" && lifecycle !== "archived") {
      sendJson(res, 400, { error: "lifecycle must be active or archived" });
      return;
    }
    let requestedProjectIds: string[];
    let clientPinnedIds: string[];
    const clientPinsAuthoritative = Object.prototype.hasOwnProperty.call(query, "pinned_ids");
    try {
      requestedProjectIds = parseSidebarProjectIds(query.project_ids);
      clientPinnedIds = [...new Set(parseSidebarIds(query.pinned_ids, "pinned_ids").map((id) => resolveConversationId(db, id)))];
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

    const conditions: string[] = ['NOT EXISTS (SELECT 1 FROM conversation_identity_aliases identity WHERE identity.alias_id = c.id)'];
    const params: unknown[] = [];
    conditions.push(lifecycle === "archived" ? "a.conversation_id IS NOT NULL" : "a.conversation_id IS NULL");
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
      conditions.push(`(c.block_count >= ? OR EXISTS (
        SELECT 1 FROM conversation_spawn_requests visible_spawn
        WHERE visible_spawn.id = c.id
          AND visible_spawn.schema_version = 'mandible-conversation-spawn-request@3'
      ))`);
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
      pinned_ids: clientPinsAuthoritative ? clientPinnedIds : null,
      lifecycle,
      sort,
    })).digest("base64url");

    let rows = db.prepare(`SELECT c.id, c.source, c.project_path, c.cwd, c.starred, c.started_at, c.block_count,
        s.project_id AS canonical_project_id,
        CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS canonical_placement_explicit,
        CASE WHEN s.id IS NULL THEN NULL ELSE p.project_key END AS canonical_project_key
      ${SIDEBAR_CONVERSATION_FROM}
      ${where}`).all(...params) as Array<ConversationSidebarRow | ProjectedConversationRow>;
    const pendingSpawns = new Map<string, ProjectedConversationRow>();
    if (!query.starred && !(Number.isFinite(minBlocks) && minBlocks > 0)) {
      const spawnRows = db.prepare(`SELECT s.*, a.archived_at FROM conversation_spawn_requests s
        LEFT JOIN conversation_archive_states a ON a.conversation_id = s.id
        WHERE s.schema_version = 'mandible-conversation-spawn-request@3'
          AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.id)
        ORDER BY s.created_at DESC, s.id`).all() as Array<{
          id: string; provider: string; project_id: string | null; checkout_id: string | null;
          request_json: string; state: string; attempt_count: number; native_session_id: string | null;
          provider_session_id: string | null; provider_receipt_json: string | null; error_json: string | null;
          schema_version: string; created_at: number; updated_at: number; archived_at: number | null;
        }>;
      for (const spawn of spawnRows) {
        if ((lifecycle === "archived") !== (spawn.archived_at != null)) continue;
        const source = spawn.provider === "codex" ? "codex" : "claude_code";
        const title = spawn.provider === "codex" ? "New Codex chat" : "New Claude chat";
        if (query.source && query.source !== source) continue;
        if (searchNeedle && !title.toLowerCase().includes(searchNeedle.toLowerCase())) continue;
        const receipt = {
          schema: "mandible-conversation-spawn-receipt@3",
          reservation_id: spawn.id,
          request: JSON.parse(spawn.request_json),
          state: spawn.state,
          attempt_count: spawn.attempt_count,
          native_session_id: spawn.native_session_id,
          provider_session_id: spawn.provider_session_id,
          provider_receipt: spawn.provider_receipt_json ? JSON.parse(spawn.provider_receipt_json) : null,
          error: spawn.error_json ? JSON.parse(spawn.error_json) : null,
          created_at: spawn.created_at,
          updated_at: spawn.updated_at,
        } as ConversationSpawnReceipt;
        const pending: ProjectedConversationRow = {
          id: spawn.id,
          source,
          source_path: `mandible://chat/${spawn.id}`,
          source_hash: "",
          source_mtime: spawn.updated_at,
          title,
          summary: null,
          started_at: new Date(spawn.created_at).toISOString(),
          ended_at: spawn.state === "failed" || spawn.state === "cancelled" ? new Date(spawn.updated_at).toISOString() : null,
          block_count: 0,
          session_id: spawn.provider_session_id ?? spawn.id,
          project_path: null,
          cwd: null,
          branch: null,
          model: null,
          cli_version: null,
          starred: 0,
          archived_at: spawn.archived_at,
          tags: "[]",
          notes: null,
          parent_conversation_id: null,
          is_sidechain: 0,
          agent_id: null,
          created_at: new Date(spawn.created_at).toISOString(),
          updated_at: new Date(spawn.updated_at).toISOString(),
          canonical_project_id: spawn.project_id,
          canonical_project_key: spawn.project_id ? projects.find((project) => project.id === spawn.project_id)?.project_key ?? null : null,
          canonical_placement_explicit: 1,
          spawn: receipt,
        };
        pendingSpawns.set(pending.id, pending);
        rows.push(pending);
      }
    }
    const searchTargets = new Map<string, string>();
    if (searchNeedle && fullTextSearch && rows.length > 0) {
      const searched = await getConversationSearchCache(db).search({
        conversationIds: rows.map((row) => row.id),
        needle: searchNeedle,
        limit: rows.length,
      });
      for (const match of searched.matches) searchTargets.set(match.conversation_id, match.block_id);
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
        ...(clientPinsAuthoritative ? { pinnedIds: clientPinnedIds } : {}),
      });
      if (groupKey && groups.length === 0) {
        sendJson(res, 400, { error: "Unknown conversation sidebar group_key" });
        return;
      }
      const pageRows = groups.flatMap((group) => group.rows);
      const hydrated = hydrateSidebarConversations(
        db,
        pageRows.filter((row) => !pendingSpawns.has(row.id)).map((row) => row.id),
      );
      const fullRow = (row: ConversationSidebarRow): ProjectedConversationRow | null => {
        const full = pendingSpawns.get(row.id) ?? hydrated.get(row.id);
        return full
          ? { ...full, canonical_project_id: row.canonical_project_id, canonical_project_key: row.canonical_project_key }
          : null;
      };
      const pages = groups.map((group) => ({
        group,
        rows: group.rows.map(fullRow).filter((row): row is ProjectedConversationRow => row !== null),
      }));
      const externalNavigation = projectConversationExternalNavigation(db, pages.flatMap((page) => page.rows));
      sendJson(res, 200, {
        groups: pages.map(({ group, rows: pageConversations }) => ({
          key: group.key,
          kind: group.kind,
          label: group.label,
          ...(group.project_id ? { project_id: group.project_id } : {}),
          ...(group.project_key ? { project_key: group.project_key } : {}),
          total: group.total,
          conversations: pageConversations.map((row) => ({
            ...mapSidebarConversation(row, fullTextSearch),
            ...(searchTargets.has(row.id)
              ? { search_target: { block: searchTargets.get(row.id)! } }
              : {}),
            ...(externalNavigation.has(row.id)
              ? { external_navigation: externalNavigation.get(row.id) }
              : {}),
          })),
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
  }, { operation: { id: "get:/api/conversations/sidebar", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

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
    const parentIdFilter = query.parent_id ? resolveConversationId(db, query.parent_id) : null;

    const conditions: string[] = ['NOT EXISTS (SELECT 1 FROM conversation_identity_aliases identity WHERE identity.alias_id = c.id)'];
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
      conditions.push(childrenOfConversationSql("c"));
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
        ? `c.*, (SELECT COUNT(*) FROM conversations ch WHERE ${childrenOfConversationSql("ch", "c.id")}) AS children_count`
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
        conversations: rows.map((row) => mapSearchConversation(row)),
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
      ? `c.*, (SELECT COUNT(*) FROM conversations ch WHERE ${childrenOfConversationSql("ch", "c.id")}) AS children_count`
      : `c.*`;

    const rows = db
      .prepare(
        `SELECT ${selectCols} FROM conversations c ${where} ORDER BY c.${safeSortField} ${sortOrder} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as ConversationRow[];

    const externalNavigation = projectConversationExternalNavigation(db, rows);
    sendJson(res, 200, {
      conversations: rows.map((row) => mapConversation(row, externalNavigation.get(row.id))),
      total: countRow.total,
      page,
      limit,
      pages: Math.ceil(countRow.total / limit),
    });
  }, { operation: { id: "get:/api/conversations", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

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

    const selectConversations = (columns: string, conditions: string[], params: unknown[]) => db
      .prepare(
        `SELECT ${columns},
           (SELECT archived_at FROM conversation_archive_states archive
             WHERE archive.conversation_id = conversations.id) AS archived_at
         FROM conversations WHERE ${conditions.join(" AND ")} ORDER BY started_at DESC`,
      )
      .all(...params) as ConversationRow[];

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
      for (const conversation of selectConversations("conversations.*", convConditions, convParams)) {
        if (results.length >= limit) break;
        const snippet = makeSnippet(maskUnverifiedCandidates(conversation.title || "").text);
        if (snippet) {
          results.push({ conversation: mapSearchConversation(conversation), block: null, snippet });
        }
      }
      sendJson(res, 200, { results, total: results.length, limit });
      return;
    }

    const eligible = db
      .prepare(`SELECT id FROM conversations WHERE ${convConditions.join(" AND ")} ORDER BY started_at DESC`)
      .all(...convParams) as Array<{ id: string }>;
    const searched = await getConversationSearchCache(db).search({
      conversationIds: eligible.map((conversation) => conversation.id),
      needle,
      blockType,
      limit,
    });
    const matchedIds = [...new Set(searched.matches.map((match) => match.conversation_id))];
    const conversationsById = new Map(
      (matchedIds.length === 0
        ? []
        : selectConversations(
          "conversations.*",
          ["conversations.id IN (SELECT value FROM json_each(?))"],
          [JSON.stringify(matchedIds)],
        )).map((conversation) => [conversation.id, conversation]),
    );
    for (const match of searched.matches) {
      const conversation = conversationsById.get(match.conversation_id);
      if (!conversation) continue;
      const read = await sourceReader.readBlock(match.block_id);
      if (read.status !== "source" && read.status !== "legacy") continue;
      const block = read.value;
      results.push({
        conversation: mapSearchConversation(conversation),
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
    const allowed = new Set(["starred", "archived", "tags", "tags_add", "tags_remove", "notes", "notes_append"]);
    const supplied = Object.keys(body);
    if (supplied.length === 0 || supplied.some((key) => !allowed.has(key))) {
      sendJson(res, 400, { error: "No updates provided" });
      return;
    }

    try {
      if ("starred" in body && body.starred !== true && body.starred !== false && body.starred !== 0 && body.starred !== 1) {
        throw new Error("starred must be a boolean");
      }
      if ("archived" in body && typeof body.archived !== "boolean") {
        throw new Error("archived must be a boolean");
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
        const spawn = db.prepare(`SELECT id FROM conversation_spawn_requests
          WHERE id = ? AND schema_version = 'mandible-conversation-spawn-request@3'`).get(id);
        if (!current && !spawn) return null;
        const conversationOnlyFields = supplied.filter((field) => field !== "archived");
        if (!current && conversationOnlyFields.length > 0) {
          throw new Error("Only archive state can be updated before a conversation materializes");
        }
        const previousArchive = db.prepare("SELECT archived_at FROM conversation_archive_states WHERE conversation_id = ?")
          .get(id) as { archived_at: number } | undefined;
        const changedFields: string[] = [];
        if ("archived" in body) {
          if (body.archived && !previousArchive) {
            db.prepare("INSERT INTO conversation_archive_states (conversation_id, archived_at) VALUES (?, ?)")
              .run(id, Date.now());
            changedFields.push("archived_at");
          } else if (!body.archived && previousArchive) {
            db.prepare("DELETE FROM conversation_archive_states WHERE conversation_id = ?").run(id);
            changedFields.push("archived_at");
          }
        }
        if (!current) {
          const archive = db.prepare("SELECT archived_at FROM conversation_archive_states WHERE conversation_id = ?")
            .get(id) as { archived_at: number } | undefined;
          return { updated: null, archivedAt: archive?.archived_at ?? null, changedFields };
        }
        let tags = canonicalizeTags(JSON.parse(current.tags), "stored tags");
        if ("tags" in body) tags = canonicalizeTags(body.tags, "tags");
        if ("tags_add" in body) tags = canonicalizeTags([...tags, ...canonicalizeTags(body.tags_add, "tags_add")], "tags");
        if ("tags_remove" in body) {
          const remove = new Set(canonicalizeTags(body.tags_remove, "tags_remove"));
          tags = tags.filter((tag) => !remove.has(tag));
        }

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
        const updated = db.prepare(`SELECT c.*, a.archived_at FROM conversations c
          LEFT JOIN conversation_archive_states a ON a.conversation_id = c.id WHERE c.id = ?`)
          .get(id) as ConversationRow;
        return { updated, archivedAt: updated.archived_at ?? null, changedFields };
      }).immediate();
      if (!result) {
        sendJson(res, 404, { error: "Conversation not found" });
        return;
      }
      broadcast(DOMAIN_EVENTS.CONVERSATION_UPDATED, { id, updates: result.changedFields });
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
