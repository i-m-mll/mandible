import type { Db } from "./db.js";
import { columnExists } from "./db-introspection.js";

import { CONVERSATION_SOURCE_TO_PROVIDER } from "./provider-identities.js";
export { CONVERSATION_SOURCE_TO_PROVIDER, PROVIDER_TO_CONVERSATION_SOURCE } from "./provider-identities.js";

export type ProviderSessionIngestion =
  | {
    status: "ingested";
    provider: string;
    provider_session_id: string;
    source_path: string;
    cwd: string | null;
    branch: string | null;
    updated_at: string | null;
    /** ISO time of the transcript's last indexed block, else its file mtime. */
    last_activity: string | null;
  }
  | { status: "not_yet_ingested"; provider_session_id: string }
  | { status: "ambiguous"; provider_session_id: string; sources: string[] }
  | { status: "unsupported"; provider_session_id: string; source: string };

interface IngestionRow {
  alias: string;
  source: string;
  source_path: string;
  cwd: string | null;
  branch: string | null;
  updated_at: string | null;
  ended_at: string | null;
  source_mtime: number | null;
}

/**
 * Resolve exact provider tasks from Mandible's normalized transcript index, in
 * at most two queries. Each id is a session's own provider id, or the agent id
 * of an in-session child (a Claude subagent), whose transcript carries its
 * parent's session id.
 */
export function resolveProviderSessionIngestions(
  db: Db,
  providerSessionIds: Iterable<string>,
): Map<string, ProviderSessionIngestion> {
  const ids = [...new Set(providerSessionIds)];
  const select = (alias: string, where: string, keys: string[]) => db.prepare(`
    SELECT ${alias} AS alias, source, source_path, cwd, branch, updated_at, ended_at, source_mtime
      FROM conversations
     WHERE ${alias} IN (SELECT value FROM json_each(?))${where}
     ORDER BY updated_at DESC, id ASC
  `).all(JSON.stringify(keys)) as IngestionRow[];
  const rowsById = groupRows(select("session_id", "", ids));
  const children = ids.filter((id) => !rowsById.has(id));
  if (children.length > 0 && columnExists(db, "conversations", "parent_session_id")) {
    for (const [id, rows] of groupRows(select("agent_id", " AND parent_session_id = session_id", children))) rowsById.set(id, rows);
  }
  return new Map(ids.map((id) => [id, ingestionFromRows(id, rowsById.get(id) ?? [])]));
}

function groupRows(rows: IngestionRow[]): Map<string, IngestionRow[]> {
  const groups = new Map<string, IngestionRow[]>();
  for (const row of rows) {
    const group = groups.get(row.alias);
    if (group) group.push(row);
    else groups.set(row.alias, [row]);
  }
  return groups;
}

function ingestionFromRows(id: string, rows: IngestionRow[]): ProviderSessionIngestion {
  if (rows.length === 0) return { status: "not_yet_ingested", provider_session_id: id };

  const sources = [...new Set(rows.map((row) => row.source))].sort();
  if (sources.length !== 1) {
    return { status: "ambiguous", provider_session_id: id, sources };
  }
  const source = sources[0];
  const provider = CONVERSATION_SOURCE_TO_PROVIDER[source];
  if (!provider) return { status: "unsupported", provider_session_id: id, source };
  const meta = rows.find((row) => row.cwd || row.branch) ?? rows[0];
  return {
    status: "ingested",
    provider,
    provider_session_id: id,
    source_path: meta.source_path,
    cwd: meta.cwd,
    branch: meta.branch,
    updated_at: meta.updated_at,
    last_activity: transcriptLastActivity(rows),
  };
}

function transcriptLastActivity(rows: Array<{ ended_at: string | null; source_mtime: number | null }>): string | null {
  const times = rows.map((row) => {
    const ended = row.ended_at ? Date.parse(row.ended_at) : NaN;
    return Number.isFinite(ended) ? ended : Number(row.source_mtime);
  }).filter((time) => Number.isFinite(time) && time > 0);
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
}
