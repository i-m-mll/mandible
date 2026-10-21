/**
 * One canonical answer to two questions that used to be answered three
 * different ways (issue 5b2cdbf):
 *
 *   1. "Does this string name a session Mandible knows about, and what are its
 *      full identities?" — {@link resolveSessionAlias}.
 *   2. "Is the agent behind this string still live?" — {@link isSessionAliasLive}.
 *
 * A caller may hold any one of four aliases for the same agent: a `sessions.id`,
 * a `console_sessions.id`, a `console_sessions.mandible_session_id`, or a
 * `console_sessions.provider_session_id` (the provider's own thread id). Before
 * this module, `src/routes/issues.ts` compared `sessions.status` directly and
 * understood only the first form, so a provider thread id — the id a Codex
 * coordinator actually has — resolved to nothing and was reported as a dead
 * holder. `src/codex-thread-archive.ts` understood all four but kept its own
 * copy of the rule, and `src/ledger/graph-adapter.ts` kept a third copy of the
 * status list.
 *
 * The liveness predicate here is the archive path's predicate, moved verbatim:
 * that path decides whether a Codex thread may be archived, and a false
 * negative there archives a live thread. Its queries are unchanged.
 *
 * Provider-native task activity is read through a leaf adapter, so every
 * consumer shares the same answer without depending on route or UI state.
 */
import type { Db } from "./db.js";
import { columnExists, tableExists } from "./db-introspection.js";
import { readCodexTaskLiveness } from "./codex-task-liveness.js";
import {
  resolveProviderSessionIngestion,
  type ProviderSessionIngestion,
} from "./provider-session-ingestion.js";

/**
 * The statuses that mean "an agent is still behind this session". `running` is
 * a `console_sessions` status; `active` and `idle` are used by both tables.
 */
export const LIVE_SESSION_STATUSES = ["active", "idle", "running"] as const;

export function isLiveSessionStatus(value: unknown): boolean {
  return value === "active" || value === "idle" || value === "running";
}

/** Every identity Mandible holds for one resolved session alias. */
export interface SessionAliasResolution {
  /** Exactly the string the caller supplied. */
  supplied_id: string;
  /** `sessions.id`, when the alias reaches a Mandible session row. */
  mandible_session_id: string | null;
  /** `console_sessions.id`, when the alias reaches a console session row. */
  console_session_id: string | null;
  /** The provider's own session/thread id, when one is recorded. */
  provider_session_id: string | null;
  /** Provider name: `sessions.app`, else the console session's command. */
  provider: string | null;
  mandible_status: string | null;
  console_status: string | null;
  /** ISO timestamp of the Mandible session's last activity, when known. */
  last_activity: string | null;
  has_live_agent: boolean;
}

interface SessionRow {
  id: string;
  app?: string | null;
  status?: string | null;
  conversation_id?: string | null;
  updated_at?: string | null;
  last_active?: string | null;
}

interface ConsoleRow {
  id: string;
  command?: string | null;
  status?: string | null;
  mandible_session_id?: string | null;
  provider_session_id?: string | null;
  updated_at?: number | null;
}

export type ProviderTaskLivenessReader = (
  sourcePath: string,
  providerSessionId: string,
) => { status: "live" | "not_live" | "unavailable" };

export interface SessionLivenessOptions {
  readCodexTaskLiveness?: ProviderTaskLivenessReader;
}

/**
 * Resolve any known alias for a session to its full identity, or `null` when
 * Mandible has no record of it.
 *
 * `null` is the signal a caller needs to refuse an unverifiable id. It is not
 * the same as "resolved but not live": a resolved-and-dead session is a real
 * session whose agent has stopped, while `null` means nothing in this Mandible
 * instance has ever claimed that string.
 */
export function resolveSessionAlias(
  db: Db,
  suppliedId: string,
  options: SessionLivenessOptions = {},
): SessionAliasResolution | null {
  const id = suppliedId.trim();
  if (!id) return null;

  const directSession = lookupSession(db, id) ?? lookupSessionByConversationId(db, id);
  const consoleRow = pickConsoleRow(db, consoleRowsForAlias(db, id));
  const providerIngestion = providerSessionIngestion(db, id);
  if (!directSession && !consoleRow && !providerIngestion) return null;

  // A console row that names a Mandible session carries the richer identity:
  // status and last activity live on `sessions`, not on `console_sessions`.
  const linkedSession = directSession
    ?? (consoleRow?.mandible_session_id ? lookupSession(db, consoleRow.mandible_session_id) : null);

  return {
    supplied_id: id,
    mandible_session_id: linkedSession?.id ?? null,
    console_session_id: consoleRow?.id ?? null,
    provider_session_id: consoleRow?.provider_session_id?.trim()
      || linkedSession?.conversation_id?.trim()
      || providerIngestion?.provider_session_id
      || null,
    provider: linkedSession?.app?.trim()
      || consoleRow?.command?.trim()
      || providerIngestion?.provider
      || null,
    mandible_status: linkedSession?.status ?? null,
    console_status: consoleRow?.status ?? null,
    last_activity: linkedSession?.last_active
      ?? linkedSession?.updated_at
      ?? providerIngestion?.updated_at
      ?? null,
    has_live_agent: isSessionAliasLive(db, id, options),
  };
}

/**
 * The id a session-to-issue link is keyed on: the provider session id when one
 * is known, else the console or session row id that is the session's only
 * identity. Linking never creates a `sessions` row.
 */
export function sessionLinkKey(resolution: SessionAliasResolution): string {
  return resolution.provider_session_id
    ?? resolution.console_session_id
    ?? resolution.mandible_session_id
    ?? resolution.supplied_id;
}

/**
 * SQL expression for the `sessions` row a link key reaches: the row whose id is
 * the key, else the latest row recording the key as its provider session id.
 */
export function sessionRowForLinkKeySql(keyExpr: string): string {
  return `(SELECT r.id FROM sessions r WHERE r.id = ${keyExpr} OR r.conversation_id = ${keyExpr}
    ORDER BY r.id = ${keyExpr} DESC, r.updated_at DESC LIMIT 1)`;
}

/** Every id the resolved session is known by, for reads keyed on any of them. */
export function sessionAliasIds(resolution: SessionAliasResolution): string[] {
  return [...new Set(
    [
      resolution.supplied_id,
      resolution.mandible_session_id,
      resolution.console_session_id,
      resolution.provider_session_id,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  )];
}

/**
 * Whether any session reachable from this alias is live.
 *
 * This is the archive path's `isProviderSessionLive`, moved unchanged. It ORs
 * over *every* matching row rather than over the single row
 * {@link resolveSessionAlias} selects for display, because "is anything still
 * running behind this id" is the conservative question the archive path must
 * ask: one live row anywhere is enough to leave the thread alone.
 */
export function isSessionAliasLive(
  db: Db,
  suppliedId: string,
  options: SessionLivenessOptions = {},
): boolean {
  const sessionRows = sessionRowsForAlias(db, suppliedId);
  for (const row of sessionRows) {
    if (isLiveSessionStatus(row.status)) return true;
  }
  if (!tableExists(db, "console_sessions")) {
    return isCodexProviderTaskLive(db, suppliedId, options);
  }
  const rows = tableExists(db, "sessions")
    ? db.prepare(
      `SELECT cs.status AS console_status, s.id AS mandible_session_id
       FROM console_sessions cs
       LEFT JOIN sessions s ON s.id = COALESCE(cs.mandible_session_id, ?)
       WHERE cs.id = ?
          OR cs.mandible_session_id = ?
          OR cs.provider_session_id = ?`,
    ).all(
      suppliedId,
      suppliedId,
      suppliedId,
      suppliedId,
    ) as Array<{ console_status?: string | null; mandible_session_id?: string | null }>
    : db.prepare(
      `SELECT cs.status AS console_status, NULL AS mandible_session_id
       FROM console_sessions cs
       WHERE cs.id = ?
          OR cs.mandible_session_id = ?
          OR cs.provider_session_id = ?`,
    ).all(
      suppliedId,
      suppliedId,
      suppliedId,
    ) as Array<{ console_status?: string | null; mandible_session_id?: string | null }>;
  for (const row of rows) {
    if (isLiveSessionStatus(row.console_status)) return true;
    if (!row.mandible_session_id) continue;
    if (isMandibleSessionLive(db, row.mandible_session_id)) return true;
  }
  return isCodexProviderTaskLive(db, suppliedId, options);
}

/**
 * Whether a `sessions.id` — and only that form — is live.
 *
 * Deliberately reads nothing but `status`. The archive path reaches this
 * function on databases whose `sessions` table is a subset — legacy installs
 * and the archive tests both build one with `id` and `status` alone — so naming
 * any other column here turns a liveness check into a thrown SqliteError.
 */
export function isMandibleSessionLive(db: Db, sessionId: string): boolean {
  if (!tableExists(db, "sessions")) return false;
  const row = db.prepare(
    "SELECT status FROM sessions WHERE id = ?",
  ).get(sessionId) as { status?: string | null } | undefined;
  return isLiveSessionStatus(row?.status);
}

/**
 * `SELECT *` for the same reason: the display columns (`app`, `last_active`,
 * `updated_at`) are optional, and a missing one must read as "unknown", never
 * as an error.
 */
function lookupSession(db: Db, sessionId: string): SessionRow | null {
  if (!tableExists(db, "sessions")) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

function lookupSessionByConversationId(db: Db, providerSessionId: string): SessionRow | null {
  if (!tableExists(db, "sessions") || !columnExists(db, "sessions", "conversation_id")) return null;
  const row = db.prepare(
    `SELECT * FROM sessions
     WHERE conversation_id = ?
     ORDER BY updated_at DESC, id ASC
     LIMIT 1`,
  ).get(providerSessionId) as SessionRow | undefined;
  return row ?? null;
}

function sessionRowsForAlias(db: Db, suppliedId: string): SessionRow[] {
  if (!tableExists(db, "sessions")) return [];
  if (!columnExists(db, "sessions", "conversation_id")) {
    const row = lookupSession(db, suppliedId);
    return row ? [row] : [];
  }
  return db.prepare(
    "SELECT * FROM sessions WHERE id = ? OR conversation_id = ? ORDER BY updated_at DESC, id ASC",
  ).all(suppliedId, suppliedId) as SessionRow[];
}

function providerSessionIngestion(db: Db, providerSessionId: string):
  Extract<ProviderSessionIngestion, { status: "ingested" }> | null {
  if (!tableExists(db, "conversations")) return null;
  try {
    const ingestion = resolveProviderSessionIngestion(db, providerSessionId);
    return ingestion.status === "ingested" ? ingestion : null;
  } catch {
    return null;
  }
}

function isCodexProviderTaskLive(
  db: Db,
  providerSessionId: string,
  options: SessionLivenessOptions,
): boolean {
  const ingestion = providerSessionIngestion(db, providerSessionId);
  if (!ingestion || ingestion.provider !== "codex") return false;
  const read = options.readCodexTaskLiveness ?? readCodexTaskLiveness;
  return read(ingestion.source_path, ingestion.provider_session_id).status === "live";
}

function consoleRowsForAlias(db: Db, suppliedId: string): ConsoleRow[] {
  if (!tableExists(db, "console_sessions")) return [];
  return db.prepare(
    `SELECT * FROM console_sessions
     WHERE id = ?
        OR mandible_session_id = ?
        OR provider_session_id = ?`,
  ).all(suppliedId, suppliedId, suppliedId) as ConsoleRow[];
}

/**
 * Choose the one console row whose identity best represents the alias: a live
 * row first, then the most recently updated, then by id so the answer is
 * deterministic when timestamps tie.
 */
function pickConsoleRow(db: Db, rows: ConsoleRow[]): ConsoleRow | null {
  if (rows.length === 0) return null;
  // Liveness is computed once per row rather than inside the comparator: it
  // costs a query, and a comparator runs O(n log n) times.
  const ranked = rows.map((row) => ({ row, live: consoleRowIsLive(db, row) }));
  ranked.sort((a, b) =>
    Number(b.live) - Number(a.live)
    || Number(b.row.updated_at ?? 0) - Number(a.row.updated_at ?? 0)
    || String(a.row.id).localeCompare(String(b.row.id))
  );
  return ranked[0]?.row ?? null;
}

function consoleRowIsLive(db: Db, row: ConsoleRow): boolean {
  if (isLiveSessionStatus(row.status)) return true;
  return row.mandible_session_id ? isMandibleSessionLive(db, row.mandible_session_id) : false;
}
