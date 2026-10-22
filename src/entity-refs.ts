import { getDb, type Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { resolveOperationalIssueRef } from "./ledger/operational-links.js";
import { resolveSessionAlias, sessionLinkKey, type SessionAliasResolution } from "./session-liveness.js";

/**
 * Entity references.
 *
 * Every short id Mandible prints (`cli/mandible-identity.jq`,
 * `shortestUniquePrefix`) is a leading prefix of the entity's full id. Route
 * inputs that name an entity resolve here, so a printed short id resolves to
 * its entity, or is refused because it names several.
 */
export type RefResolution =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "ambiguous"; matches: string[] };

/** A bound resolver for one route input. */
export type RefResolver = (ref: string) => RefResolution;

const NOT_FOUND = { ok: false, error: "not_found" } as const;
const MIN_PREFIX_LENGTH = 4;
const MATCH_SAMPLE = 5;

const ID_SOURCES = {
  auth_request: ["auth_requests", "id"],
  auth_action: ["auth_request_actions", "id"],
  auth_clearance: ["auth_clearances", "id"],
  binding: ["user_bindings", "id"],
  body_revision: ["ledger_body_revisions", "id"],
  briefing_bundle: ["briefing_bundles", "id"],
  briefing_group: ["briefing_groups", "id"],
  briefing_round: ["briefing_rounds", "id"],
  checkpoint: ["ledger_issue_checkpoints", "id"],
  comment: ["ledger_comments", "id"],
  credential: ["user_credentials", "id"],
  grant: ["permission_grants", "id"],
  reminder: ["managed_tasks", "id"],
  session_row: ["sessions", "id"],
  space: ["spaces", "id"],
  space_block: ["space_blocks", "id"],
  space_edge: ["space_edges", "id"],
  space_item: ["space_items", "id"],
  space_occurrence: ["space_occurrences", "id"],
  trash_entry: ["trash_entries", "id"],
  work_unit: ["work_units", "id"],
} as const satisfies Record<string, readonly [string, string]>;

export type IdKind = keyof typeof ID_SOURCES;

/** The smallest string greater than every string that starts with `prefix`. */
function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/** Distinct full values of `table.column` that start with `prefix`, at most `limit`. */
function prefixMatches(db: Db, table: string, column: string, prefix: string, limit: number): string[] {
  return (db.prepare(
    `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} >= ? AND ${column} < ? ORDER BY ${column} LIMIT ?`,
  ).all(prefix, prefixUpperBound(prefix), limit) as Array<{ value: string }>).map((row) => row.value);
}

/** Resolve an exact id, or a unique prefix of one, of the given kind. */
export function resolveId(db: Db, kind: IdKind, ref: string): RefResolution {
  const [table, column] = ID_SOURCES[kind];
  const trimmed = ref.trim();
  if (!trimmed) return NOT_FOUND;
  const exact = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} = ?`).get(trimmed) as { value: string } | undefined;
  if (exact) return { ok: true, id: exact.value };
  if (trimmed.length < MIN_PREFIX_LENGTH) return NOT_FOUND;
  const matches = prefixMatches(db, table, column, trimmed, MATCH_SAMPLE);
  if (matches.length === 0) return NOT_FOUND;
  if (matches.length > 1) return { ok: false, error: "ambiguous", matches };
  return { ok: true, id: matches[0] };
}

/**
 * Resolve a comment: `<issue>#<ordinal>`, `<issue>#last`, or a comment id or
 * its prefix. Ordinal 0 is the issue description, not a comment.
 */
export function resolveCommentRef(db: Db, ref: string): RefResolution {
  const trimmed = ref.trim();
  const hash = trimmed.lastIndexOf("#");
  if (hash < 0) return resolveId(db, "comment", trimmed);
  const selector = trimmed.slice(hash + 1);
  const issue = resolveOperationalIssueRef(db, trimmed.slice(0, hash));
  if (!issue.ok) {
    return issue.error === "ambiguous" ? { ok: false, error: "ambiguous", matches: issue.matches ?? [] } : NOT_FOUND;
  }
  const row = selector === "last"
    ? db.prepare("SELECT id FROM ledger_comments WHERE issue_id = ? AND deleted_at IS NULL ORDER BY ordinal DESC LIMIT 1")
      .get(issue.issue_id)
    : /^[1-9]\d*$/.test(selector)
      ? db.prepare("SELECT id FROM ledger_comments WHERE issue_id = ? AND ordinal = ? AND deleted_at IS NULL")
        .get(issue.issue_id, Number(selector))
      : undefined;
  return row ? { ok: true, id: (row as { id: string }).id } : NOT_FOUND;
}

// A session is named by any alias `resolveSessionAlias` resolves — a provider
// session id, a Claude subagent id, a `sessions.id`, a console session id — or
// by a prefix of one of at least eight characters. Candidates naming the same
// session collapse, so only distinct sessions are ambiguous.
const SESSION_REF_MIN_PREFIX_LENGTH = 8;
const SESSION_PREFIX_CANDIDATE_LIMIT = 20;
const FULL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SESSION_ALIAS_SOURCES: ReadonlyArray<readonly [string, string, string]> = [
  ["conversations", "session_id", ""],
  ["conversations", "agent_id", " AND parent_session_id = session_id"],
  ["sessions", "id", ""],
  ["sessions", "conversation_id", ""],
  ["console_sessions", "id", ""],
  ["console_sessions", "provider_session_id", ""],
];

export type SessionRefResolution =
  | { status: "resolved"; resolution: SessionAliasResolution }
  | { status: "ambiguous"; candidates: SessionAliasResolution[]; truncated: boolean }
  | { status: "not_found" };

function sessionPrefixCandidates(db: Db, ref: string): { candidates: string[]; truncated: boolean } {
  const candidates = new Set<string>();
  let truncated = false;
  for (const [table, column, filter] of SESSION_ALIAS_SOURCES) {
    if (!tableExists(db, table)) continue;
    const rows = db.prepare(
      `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} >= ? AND ${column} < ?${filter} LIMIT ?`,
    ).all(ref, prefixUpperBound(ref), SESSION_PREFIX_CANDIDATE_LIMIT + 1) as Array<{ value: string | null }>;
    if (rows.length > SESSION_PREFIX_CANDIDATE_LIMIT) truncated = true;
    for (const row of rows) if (row.value) candidates.add(row.value);
  }
  return { candidates: [...candidates], truncated };
}

export function resolveSessionRef(db: Db, rawRef: string): SessionRefResolution {
  const ref = rawRef.trim();
  const exact = resolveSessionAlias(db, ref);
  if (exact) return { status: "resolved", resolution: exact };
  if (ref.length < SESSION_REF_MIN_PREFIX_LENGTH || FULL_UUID_RE.test(ref)) return { status: "not_found" };
  const { candidates, truncated } = sessionPrefixCandidates(db, ref);
  const sessions = new Map<string, SessionAliasResolution>();
  for (const candidate of candidates) {
    const resolution = resolveSessionAlias(db, candidate);
    if (resolution && !sessions.has(sessionLinkKey(resolution))) sessions.set(sessionLinkKey(resolution), resolution);
  }
  const resolved = [...sessions.values()];
  if (resolved.length === 1 && !truncated) return { status: "resolved", resolution: resolved[0] };
  if (resolved.length === 0) return { status: "not_found" };
  return { status: "ambiguous", candidates: resolved, truncated };
}

function sessionAliasRecorded(db: Db, alias: string): boolean {
  return SESSION_ALIAS_SOURCES.some(([table, column, filter]) => tableExists(db, table)
    && db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?${filter} LIMIT 1`).get(alias) !== undefined);
}

/** A session alias, completed to the full alias its prefix names. */
function resolveSessionAliasRef(db: Db, ref: string): RefResolution {
  const trimmed = ref.trim();
  if (sessionAliasRecorded(db, trimmed)) return { ok: true, id: trimmed };
  const resolved = resolveSessionRef(db, trimmed);
  if (resolved.status === "resolved") return { ok: true, id: resolved.resolution.supplied_id };
  if (resolved.status === "ambiguous") {
    return { ok: false, error: "ambiguous", matches: resolved.candidates.map((candidate) => candidate.supplied_id) };
  }
  return NOT_FOUND;
}

const bind = (kind: IdKind): RefResolver => (ref) => resolveId(getDb(), kind, ref);

/** Route-input resolvers, bound to the daemon database, for `RouteOptions.refs`. */
export const entityRefs = {
  authRequest: bind("auth_request"),
  authClearance: bind("auth_clearance"),
  binding: bind("binding"),
  bodyRevision: bind("body_revision"),
  briefingRound: bind("briefing_round"),
  checkpoint: bind("checkpoint"),
  comment: ((ref) => resolveCommentRef(getDb(), ref)) as RefResolver,
  credential: bind("credential"),
  grant: bind("grant"),
  session: ((ref) => resolveSessionAliasRef(getDb(), ref)) as RefResolver,
  spaceBlock: bind("space_block"),
  spaceEdge: bind("space_edge"),
  spaceItem: bind("space_item"),
  spaceOccurrence: bind("space_occurrence"),
  trashEntry: bind("trash_entry"),
  workUnit: bind("work_unit"),
} satisfies Record<string, RefResolver>;
