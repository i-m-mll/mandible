import type { Db } from "./db.js";

export const PROVIDER_TO_CONVERSATION_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  codex: "codex",
  claude: "claude_code",
  gemini: "gemini",
});

export const CONVERSATION_SOURCE_TO_PROVIDER: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_TO_CONVERSATION_SOURCE).map(([provider, source]) => [source, provider]),
  ),
);

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

/** Resolve one exact provider task from Mandible's normalized transcript index. */
export function resolveProviderSessionIngestion(
  db: Db,
  providerSessionId: string,
): ProviderSessionIngestion {
  const id = providerSessionId.trim();
  const rows = db.prepare(`
    SELECT source, source_path, cwd, branch, updated_at, ended_at, source_mtime
      FROM conversations
     WHERE session_id = ?
     ORDER BY updated_at DESC, id ASC
  `).all(id) as Array<{
    source: string;
    source_path: string;
    cwd: string | null;
    branch: string | null;
    updated_at: string | null;
    ended_at: string | null;
    source_mtime: number | null;
  }>;
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
