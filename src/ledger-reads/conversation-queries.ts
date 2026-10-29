import { ConversationSourceReader } from "../conversations/source-reader.js";
import { snippetFor } from "../conversations/search-cache.js";
import { maskUnverifiedCandidates } from "../credential-leak-scan.js";
import { readSnapshot } from "./snapshot.js";
import { childrenOfConversationSql } from "../conversation-lineage.js";
import { resolveConversationId } from "../conversations/identity.js";
import type { Db } from "../db.js";
import { getFullTextSearchJobs, isFullTextSearch, SearchSnapshotProjectionError, type SearchPlan, type SearchQuery } from "../conversations/full-text-search-jobs.js";
import { ConversationSidebarCursorError, buildConversationSidebar, type ConversationSidebarRow } from "../conversations/sidebar-projection.js";
import { projectConversationExternalNavigation } from "../conversation-external-navigation.js";
import { mapConversation, mapSearchConversation, mapSidebarConversation } from "../conversations/response-mapping.js";
import { parseSinceQuery, sourceFromQuery, blockTypeFromRole } from "../conversations/search-query.js";
import { conversationSidebarCandidates, hydrateSidebarConversations, conversationSearchCandidates, conversationSearchRows, type ProjectedConversationRow, type ConversationRow } from "./conversations.js";
const FROZEN_SEARCH_FIELDS = ["id", "source", "starred", "tags", "block_count", "session_id", "started_at", "ended_at", "branch", "model", "parent_conversation_id", "project_path", "cwd", "title", "created_at", "updated_at"] as const;
type FrozenSearchMetadata = Pick<ConversationRow, typeof FROZEN_SEARCH_FIELDS[number]>&Pick<ConversationRow,"children_count">;
const frozenSearchSelect = FROZEN_SEARCH_FIELDS.map(field => `c.${field}`).join(",");
function listSelect(groupMode:boolean,fields="c.*"):string {
  return groupMode?`${fields},(SELECT COUNT(*) FROM conversations ch WHERE ${childrenOfConversationSql("ch","c.id")}) AS children_count`:fields;
}
function frozenSearchMetadata(db: Db, ids: readonly string[]): Map<string, FrozenSearchMetadata> {
  const rows = db.prepare(`SELECT ${frozenSearchSelect} FROM conversations c WHERE c.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as FrozenSearchMetadata[];
  return new Map(rows.map(row => [row.id, row]));
}
function response(status: number, body: unknown) {
  return { status, json: JSON.stringify(body) };
}
export async function conversationSidebar(db: Db, input: {
  query: SearchQuery;
  searchStart?: boolean;
}) {
  const prepare = () => readSnapshot(db, () => {
    const candidates = conversationSidebarCandidates(db, { query: input.query ?? {} });
    if (!candidates.ok)
      return { error: candidates.error };
    const { fullTextSearch } = candidates;
    const searchTargets = new Map<string, string>();
    const finish = (current = candidates, matching?: Set<string>, searchId?: string, pageQuery: SearchQuery = input.query) => {
      const { pendingSpawns, projects, requestedProjectIds, clientPinnedIds, clientPinsAuthoritative, limit, groupKey, cursor, sort, querySignature } = current;
      const rows = matching ? current.rows.filter((row) => matching.has(row.id)) : current.rows;
      try {
        const groups = buildConversationSidebar({
          rows,
          sort,
          querySignature: searchId ? `${querySignature}:${searchId}` : querySignature,
          limit: Math.min(100, Math.max(1, parseInt(pageQuery.limit || String(limit), 10) || limit)),
          groupKey: pageQuery.group_key || groupKey,
          cursor: pageQuery.cursor || cursor,
          projects,
          requestedProjectIds,
          ...(clientPinsAuthoritative ? { pinnedIds: clientPinnedIds } : {}),
        });
        if ((pageQuery.group_key || groupKey) && groups.length === 0) {
          return response(400, { error: "Unknown conversation sidebar group_key" });
        }
        const pageRows = groups.flatMap((group) => group.rows);
        const hydrated = hydrateSidebarConversations(db, {
          ids: pageRows.filter((row) => !pendingSpawns.has(row.id)).map((row) => row.id),
        });
        const fullRow = (row: ConversationSidebarRow): ProjectedConversationRow | null => {
          const full = pendingSpawns.get(row.id) ?? hydrated.get(row.id);
          return full
            ? { ...full, ...row, canonical_placement_explicit: Number(row.canonical_placement_explicit || 0), canonical_project_id: row.canonical_project_id, canonical_project_key: row.canonical_project_key }
            : null;
        };
        if (pageRows.some(row => !pendingSpawns.has(row.id) && !hydrated.has(row.id)))
          throw new Error("Snapshot conversation unavailable");
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
          limit: Math.min(100, Math.max(1, parseInt(pageQuery.limit || String(limit), 10) || limit)),
        });
      }
      catch (error) {
        if (error instanceof ConversationSidebarCursorError) {
          return response(400, { error: error.message });
        }
        throw error;
      }
    };
    return { candidates, finish, searchTargets };
  });
  if (isFullTextSearch("conversation_sidebar", input.query)) {
    return getFullTextSearchJobs(db).request("conversation_sidebar", input.query, () => {
      const prepared = prepare();
      if (prepared.error || !prepared.candidates || !prepared.finish)
        throw new Error("Invalid sidebar query");
      const { candidates, finish, searchTargets } = prepared;
      return {
        ids: candidates.rows.filter(row => !candidates.pendingSpawns.has(row.id)).map(row => row.id), needle: candidates.searchNeedle,
        metadataBytes: Buffer.byteLength(JSON.stringify(candidates.rows)) + Buffer.byteLength(JSON.stringify(candidates.projects)),
        render(matches, query, searchId) {
          searchTargets.clear();
          for (const match of matches)
            searchTargets.set(match.conversation_id, match.block_id);
          const result = readSnapshot(db, () => finish(candidates, new Set(matches.map(match => match.conversation_id)), searchId, query));
          if (result.status !== 200)
            throw new SearchSnapshotProjectionError("query_mismatch");
          return JSON.parse(result.json);
        },
      };
    }, input.searchStart);
  }
  const prepared = prepare();
  return prepared.error ? response(400, prepared.error) : prepared.finish!();
}
export async function conversationSearch(db: Db, input: {
  query: SearchQuery;
  searchStart?: boolean;
}) {
  const query = input.query ?? {};
  const needle = (query.q || query.query || "").trim().toLowerCase();
  if (!needle)
    return response(400, { error: "Missing search query" });
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || "20", 10) || 20));
  const source = sourceFromQuery(query.source || query.provider);
  const since = parseSinceQuery(query.since);
  const titleOnly = query.title === "true" || query.title === "1";
  const blockType = blockTypeFromRole(query.role);
  if (titleOnly) {
    const candidates = readSnapshot(db, () => conversationSearchCandidates(db, { source, since, titleOnly, needle, limit }));
    const results = candidates.titleMatches.map(({ conversation, snippet }) => ({ conversation: mapSearchConversation(conversation), block: null, snippet }));
    return response(200, { results, total: results.length, limit });
  }
  return getFullTextSearchJobs(db).request("conversation_search", query, () => {
    const candidates = readSnapshot(db, () => conversationSearchCandidates(db, { source, since, titleOnly: false, needle, limit }));
    const frozen = frozenSearchMetadata(db, candidates.ids);
    return {
      ids: candidates.ids, needle, blockType, metadataBytes: Buffer.byteLength(JSON.stringify([...frozen.values()])),
      async render(matches, pageQuery) {
        const pageLimit = Math.min(100, Math.max(1, parseInt(pageQuery.limit || "20", 10) || 20));
        const offset = Math.max(0, parseInt(pageQuery.offset || "0", 10) || 0);
        const selected = matches.slice(offset, offset + pageLimit);
        const rows = readSnapshot(db, () => conversationSearchRows(db, { ids: selected.map(match => match.conversation_id) }));
        const results = [];
        const reader = new ConversationSourceReader(db);
        for (const match of selected) {
          const conversation = rows.get(match.conversation_id);
          const read = await reader.readBlock(match.block_id, { expectedSourceVersionId: match.source_version_id, expectedBlockCount: match.source_block_count, expectedModel: match.source_model });
          if (!conversation || read.status !== "source" || read.sourceVersionId !== match.source_version_id)
            throw new SearchSnapshotProjectionError("source_changed");
          const snippet = snippetFor(maskUnverifiedCandidates(read.value.content).text, needle);
          if (snippet === null)
            throw new SearchSnapshotProjectionError("source_changed");
          results.push({ conversation: mapSearchConversation({ ...conversation, ...frozen.get(match.conversation_id) }), block: { ...read.value, content: "" }, snippet });
        }
        return { results, total: matches.length, limit: pageLimit };
      },
    };
  }, input.searchStart);
}
function listQuery(db: Db, input: {
  query: SearchQuery;
}) {
  const query = input.query ?? {};
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
  }
  else if (query.starred === "false" || query.starred === "0") {
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
  }
  else if (excludeSubagents) {
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
  return { where, params, safeSortField, sortOrder, groupMode, searchNeedle };
}
function prepareListSearch(db: Db, input: {
  query: SearchQuery;
}): SearchPlan {
  const { where, params, safeSortField, sortOrder, searchNeedle,groupMode } = listQuery(db, input);
  const rows = db.prepare(`SELECT ${listSelect(groupMode,frozenSearchSelect)} FROM conversations c ${where} ORDER BY c.${safeSortField} ${sortOrder}, c.id`).all(...params) as FrozenSearchMetadata[];
  const frozen = new Map(rows.map(row => [row.id, row]));
  return {
    ids: rows.map(row => row.id), needle: searchNeedle, metadataBytes: Buffer.byteLength(JSON.stringify(rows)),
    render(matches, pageQuery) {
      const page = Math.max(1, parseInt(pageQuery.page || "1", 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(pageQuery.limit || "50", 10) || 50));
      const parsedOffset = parseInt(pageQuery.offset || "", 10);
      const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : (page - 1) * limit;
      const ids = matches.map(match => match.conversation_id);
      const pageIds = ids.slice(offset, offset + limit);
      const hydrated = hydrateSidebarConversations(db, { ids: pageIds });
      const conversations = pageIds.map(id => hydrated.get(id)).filter((row): row is ProjectedConversationRow => Boolean(row));
      if (conversations.length !== pageIds.length)
        throw new Error("Snapshot conversation unavailable");
      return { conversations: conversations.map(row => mapSearchConversation({ ...row, ...frozen.get(row.id) })), total: ids.length, page, limit, pages: Math.ceil(ids.length / limit) };
    },
  };
}
export async function conversationList(db: Db, input: {
  query: SearchQuery;
  searchStart?: boolean;
}) {
  if (isFullTextSearch("conversation_list", input.query))
    return getFullTextSearchJobs(db).request("conversation_list", input.query, () => readSnapshot(db, () => prepareListSearch(db, input)), input.searchStart);
  const phase = readSnapshot(db, () => {
    const query = input.query ?? {};
    const page = Math.max(1, parseInt(query.page || "1", 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || "50", 10) || 50));
    const parsedOffset = parseInt(query.offset || "", 10);
    const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : (page - 1) * limit;
    const { where, params, safeSortField, sortOrder, groupMode } = listQuery(db, input);
    // Count total
    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM conversations c ${where}`)
      .get(...params) as {
      total: number;
    };
    // Fetch page — include children_count via subquery when grouping
    const selectCols=listSelect(groupMode);
    const rows = db
      .prepare(`SELECT ${selectCols} FROM conversations c ${where} ORDER BY c.${safeSortField} ${sortOrder} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ConversationRow[];
    const externalNavigation = projectConversationExternalNavigation(db, rows);
    return response(200, {
      conversations: rows.map((row) => mapConversation(row, externalNavigation.get(row.id))),
      total: countRow.total,
      page,
      limit,
      pages: Math.ceil(countRow.total / limit),
    });
  });
  return phase;
}
