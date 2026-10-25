import { getDb } from "../db.js";
import { maskUnverifiedCandidates } from "../credential-leak-scan.js";
import type { ConversationRow, ProjectedConversationRow } from "../ledger-reads/conversations.js";
import type { ConversationExternalNavigation } from "../contracts.js";
import type { ConversationSpawnReceipt } from "../conversation-spawn/types.js";

export function mapConversation(row: ConversationRow, externalNavigation?: ConversationExternalNavigation) {
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

export function maskSourceBackedConversationRow(row: ConversationRow): ConversationRow {
  return {
    ...row,
    title: maskUnverifiedCandidates(row.title).text,
    summary: row.summary == null ? null : maskUnverifiedCandidates(row.summary).text,
    notes: row.notes == null ? null : maskUnverifiedCandidates(row.notes).text,
  };
}

export function mapSearchConversation(row: ConversationRow) {
  return mapConversation(maskSourceBackedConversationRow(row));
}

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

export function mapSidebarConversation(
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

