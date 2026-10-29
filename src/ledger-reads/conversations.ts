import { maskUnverifiedCandidates } from "../credential-leak-scan.js";
import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import type { RetentionNativeProjection } from "../conversations/retention-contract.js";
import { MAX_ORDERED_SIDEBAR_IDS } from "../host-user-preferences.js";
import { resolveConversationId } from "../conversations/identity.js";
import type { ConversationSpawnReceipt } from "../conversation-spawn/types.js";
import type { ConversationSidebarProject, ConversationSidebarRow, ConversationSidebarSort } from "../conversations/sidebar-projection.js";

export interface ConversationRow extends Partial<RetentionNativeProjection> {
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

export type ProjectedConversationRow = ConversationRow & {
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

const SIDEBAR_CONVERSATION_FROM = `FROM conversations c
      LEFT JOIN conversation_archive_states a ON a.conversation_id = c.id
      LEFT JOIN conversation_spawn_requests s ON s.id = COALESCE(
        (SELECT alias_id FROM conversation_identity_aliases WHERE canonical_id = c.id ORDER BY alias_id LIMIT 1), c.id
      ) AND s.schema_version = 'mandible-conversation-spawn-request@3'
      LEFT JOIN ledger_projects p ON p.id = s.project_id`;

export function hydrateSidebarConversations(
  db: Db,
  { ids }: { ids: readonly string[] },
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

function loadSidebarProjects(db: Db): ConversationSidebarProject[] {
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

export function conversationSidebarCandidates(db: Db, { query }: { query: Record<string, string | undefined> }) {
  const lifecycle = query.lifecycle || "active";
  if (lifecycle !== "active" && lifecycle !== "archived") {
    return { ok: false as const, error: { error: "lifecycle must be active or archived" } };
  }
  let requestedProjectIds: string[];
  let clientPinnedIds: string[];
  const clientPinsAuthoritative = Object.prototype.hasOwnProperty.call(query, "pinned_ids");
  try {
    requestedProjectIds = parseSidebarProjectIds(query.project_ids);
    clientPinnedIds = [...new Set(parseSidebarIds(query.pinned_ids, "pinned_ids").map((id) => resolveConversationId(db, id)))];
  } catch (error) {
    return { ok: false as const, error: { error: error instanceof Error ? error.message : String(error) } };
  }
  const projects = loadSidebarProjects(db);
  const knownProjectIds = new Set(projects.map((project) => project.id));
  const unknownProjectIds = requestedProjectIds.filter((id) => !knownProjectIds.has(id));
  if (unknownProjectIds.length > 0) {
    return { ok: false as const, error: { error: "Unknown canonical project id", project_ids: unknownProjectIds } };
  }
  const parsedLimit = parseInt(query.limit || "20", 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 20));
  const groupKey = query.group_key || undefined;
  const cursor = query.cursor || undefined;
  if (cursor && !groupKey) {
    return { ok: false as const, error: { error: "group_key is required with cursor" } };
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

  const rows = db.prepare(`SELECT c.id, c.source, c.project_path, c.cwd, c.starred, c.started_at, c.block_count,
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
  return { ok: true as const, rows, pendingSpawns, projects, requestedProjectIds, clientPinnedIds, clientPinsAuthoritative, limit, groupKey, cursor, sort, querySignature, searchNeedle, fullTextSearch };
}

function selectSearchConversations(db: Db, where: string, params: readonly string[]): ConversationRow[] {
  return db.prepare(`SELECT conversations.*,
    (SELECT archived_at FROM conversation_archive_states archive WHERE archive.conversation_id = conversations.id) AS archived_at
    FROM conversations ${where} ORDER BY started_at DESC, id ASC`).all(...params) as ConversationRow[];
}

export function conversationSearchCandidates(db: Db, { source, since, titleOnly, needle, limit }: {
  source: string | null;
  since: string | null;
  titleOnly: boolean;
  needle: string;
  limit: number;
}) {
  const conditions: string[] = ["NOT EXISTS (SELECT 1 FROM conversation_identity_aliases identity WHERE identity.alias_id = conversations.id)"];
  const params: string[] = [];
  if (source) {
    conditions.push("source = ?");
    params.push(source);
  }
  if (since) {
    conditions.push("started_at >= ?");
    params.push(since);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const titleMatches: Array<{ conversation: ConversationRow; snippet: string }> = [];
  if (titleOnly) {
    for (const conversation of selectSearchConversations(db, where, params)) {
      if (titleMatches.length >= limit) break;
      const text = maskUnverifiedCandidates(conversation.title || "").text;
      const index = text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + needle.length + 80);
      const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
      if (snippet) titleMatches.push({
        conversation,
        snippet: `${start > 0 ? "..." : ""}${snippet}${end < text.length ? "..." : ""}`,
      });
    }
    return { titleMatches, ids: [] as string[] };
  }
  const rows = db.prepare(`SELECT id FROM conversations ${where} ORDER BY started_at DESC, id ASC`).all(...params) as Array<{ id: string }>;
  return { titleMatches, ids: rows.map(row => row.id) };
}

export function conversationSearchRows(db: Db, { ids }: { ids: string[] }) {
  if (!ids.length) return new Map<string, ConversationRow>();
  const rows = selectSearchConversations(db, "WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(ids)]);
  return new Map(rows.map(row => [row.id, row]));
}
