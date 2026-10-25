import { childrenOfConversationSql } from "../conversation-lineage.js";
import { resolveConversationId } from "../conversations/identity.js";
import type { Db } from "../db.js";
import { ConversationSourceReader } from "../conversations/source-reader.js";
import { getConversationSearchCache } from "../conversations/search-cache.js";
import { ConversationSidebarCursorError, buildConversationSidebar, type ConversationSidebarRow } from "../conversations/sidebar-projection.js";
import { projectConversationExternalNavigation } from "../conversation-external-navigation.js";
import { mapConversation, mapSearchConversation, mapSidebarConversation } from "../conversations/response-mapping.js";
import { parseSinceQuery, sourceFromQuery, blockTypeFromRole } from "../conversations/search-query.js";
import { conversationSidebarCandidates, hydrateSidebarConversations, conversationSearchCandidates, conversationSearchRows, type ProjectedConversationRow, type ConversationRow } from "./conversations.js";
import type { SourceBackedConversationBlock } from "../conversations/source-types.js";

function response(status: number, body: unknown) {
  return { status, json: JSON.stringify(body) };
}

export async function conversationSidebar(db: Db, input: { query: Record<string, string | undefined> }) {
  const candidates = conversationSidebarCandidates(db, { query: input.query ?? {} });
  if (!candidates.ok) {
    return response(400, candidates.error);
  }
  const { pendingSpawns, projects, requestedProjectIds, clientPinnedIds, clientPinsAuthoritative, limit, groupKey, cursor, sort, querySignature, searchNeedle, fullTextSearch } = candidates;
  let rows = candidates.rows;
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
      return response(400, { error: "Unknown conversation sidebar group_key" });
    }
    const pageRows = groups.flatMap((group) => group.rows);
    const hydrated = hydrateSidebarConversations(db, {
      ids: pageRows.filter((row) => !pendingSpawns.has(row.id)).map((row) => row.id),
    });
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
    return response(200, {
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
      return response(400, { error: error.message });
    }
    throw error;
  }
}

export async function conversationSearch(db: Db, input: { query: Record<string, string | undefined> }) {
  const sourceReader = new ConversationSourceReader(db);
  const query = input.query ?? {};
  const needle = (query.q || query.query || "").trim().toLowerCase();
  if (!needle) {
    return response(400, { error: "Missing search query" });
  }

  const limit = Math.min(100, Math.max(1, parseInt(query.limit || "20", 10) || 20));
  const source = sourceFromQuery(query.source || query.provider);
  const since = parseSinceQuery(query.since);
  const titleOnly = query.title === "true" || query.title === "1";
  const blockType = blockTypeFromRole(query.role);

  const candidates = conversationSearchCandidates(db, { source, since, titleOnly, needle, limit });

  const results: Array<{
    conversation: ReturnType<typeof mapSearchConversation>;
    block: SourceBackedConversationBlock | null;
    snippet: string;
  }> = [];

  if (titleOnly) {
    for (const { conversation, snippet } of candidates.titleMatches) {
      results.push({ conversation: mapSearchConversation(conversation), block: null, snippet });
    }
    return response(200, { results, total: results.length, limit });
  }

  const searched = await getConversationSearchCache(db).search({
    conversationIds: candidates.ids,
    needle,
    blockType,
    limit,
  });
  const matchedIds = [...new Set(searched.matches.map((match) => match.conversation_id))];
  const conversationsById = conversationSearchRows(db, { ids: matchedIds });
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

  return response(200, {
    results,
    total: results.length,
    limit,
    search_metrics: searched.metrics,
  });
}

export async function conversationList(db: Db, input: { query: Record<string, string | undefined> }) {
    const query = input.query ?? {};
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
    return response(200, {
      conversations: rows.map((row) => mapSearchConversation(row)),
      total: ids.length,
      page,
      limit,
      pages: Math.ceil(ids.length / limit),
      search_metrics: searched.metrics,
    });
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
  return response(200, {
    conversations: rows.map((row) => mapConversation(row, externalNavigation.get(row.id))),
    total: countRow.total,
    page,
    limit,
    pages: Math.ceil(countRow.total / limit),
  });
}
