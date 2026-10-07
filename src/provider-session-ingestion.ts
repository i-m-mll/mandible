import type { Db } from "./db.js";
import type { SessionRegistry } from "./registry.js";
import type { Session } from "./types.js";

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
    SELECT source, source_path, cwd, branch, updated_at
      FROM conversations
     WHERE session_id = ?
     ORDER BY updated_at DESC, id ASC
  `).all(id) as Array<{
    source: string;
    source_path: string;
    cwd: string | null;
    branch: string | null;
    updated_at: string | null;
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
  };
}

export type ProviderSessionRegistration =
  | { status: "registered"; provider: string; session: Session }
  | Exclude<ProviderSessionIngestion, { status: "ingested" }>;

/**
 * Materialize only the durable Mandible session identity needed by issue-link
 * foreign keys. Provider task activity remains derived from provider-owned
 * state and is never copied into the row as liveness authority.
 */
export function ensureProviderSessionRegistered(
  db: Db,
  registry: SessionRegistry,
  providerSessionId: string,
): ProviderSessionRegistration {
  const ingestion = resolveProviderSessionIngestion(db, providerSessionId);
  if (ingestion.status !== "ingested") return ingestion;
  const session = registry.registerSession({
    id: `${ingestion.provider}-${ingestion.provider_session_id}`,
    app: ingestion.provider,
    agent_type: "provider-session",
    conversation_id: ingestion.provider_session_id,
    ...(ingestion.cwd ? { cwd: ingestion.cwd } : {}),
    ...(ingestion.branch ? { branch: ingestion.branch } : {}),
  });
  return { status: "registered", provider: ingestion.provider, session };
}
