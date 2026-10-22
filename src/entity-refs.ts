import { getDb, type Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { resolveOperationalIssueRef } from "./ledger/operational-links.js";
import { resolveSessionAlias, sessionLinkKey, type SessionAliasResolution } from "./session-liveness.js";

/**
 * Entity references.
 *
 * Every short id Mandible prints (`cli/mandible-identity.jq`, `shortRef`) is a
 * leading prefix of the entity's full id. Route inputs that name an entity
 * resolve here, so a printed short id resolves to its entity, or is refused
 * because it names several.
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

/** One column whose values name entities of a kind. */
interface IdSource {
  readonly table: string;
  readonly column: string;
  /** The id column a match names; the matched column itself when omitted. */
  readonly yields?: string;
  /** How a key is spelled in this column; the key itself when omitted. */
  readonly spell?: (key: string) => string;
}

interface IdKindSpec {
  readonly sources: readonly IdSource[];
  /** A column on every source table that a lookup may be scoped by. */
  readonly scope?: string;
  readonly minPrefix?: number;
}

const byId = (table: string): IdKindSpec => ({ sources: [{ table, column: "id" }] });

const ID_KINDS = {
  artifact: {
    sources: [
      { table: "artifact", column: "id", spell: (key) => `artifact:${key}` },
      { table: "artifact", column: "identity_key", yields: "id" },
    ],
    minPrefix: 7,
  },
  artifact_blob: {
    sources: [
      { table: "artifact_blob", column: "id", spell: (key) => `artifact-blob:${key}` },
      { table: "artifact_blob", column: "content_hash", yields: "id" },
    ],
    minPrefix: 7,
  },
  artifact_version: {
    sources: [{ table: "artifact_version", column: "id", spell: (key) => `artifact-version:${key}` }],
    minPrefix: 7,
  },
  auth_request: byId("auth_requests"),
  auth_action: byId("auth_request_actions"),
  auth_clearance: byId("auth_clearances"),
  binding: byId("user_bindings"),
  body_revision: byId("ledger_body_revisions"),
  // Legacy Briefing ids store the `briefing:` typed-ref prefix themselves.
  briefing: {
    sources: [
      { table: "briefings", column: "id" },
      { table: "briefings", column: "id", spell: (key) => `briefing:${key}` },
    ],
  },
  briefing_bundle: byId("briefing_bundles"),
  briefing_group: byId("briefing_groups"),
  briefing_round: byId("briefing_rounds"),
  checkpoint: byId("ledger_issue_checkpoints"),
  comment: byId("ledger_comments"),
  credential: byId("user_credentials"),
  grant: byId("permission_grants"),
  issue: {
    sources: [
      { table: "ledger_issues", column: "id" },
      { table: "ledger_issues", column: "short_id", yields: "id" },
      { table: "ledger_issue_aliases", column: "alias", yields: "issue_id" },
    ],
    scope: "project_id",
  },
  reminder: byId("managed_tasks"),
  reminder_occurrence: byId("managed_task_occurrences"),
  session_row: byId("sessions"),
  space: byId("spaces"),
  space_block: byId("space_blocks"),
  space_edge: byId("space_edges"),
  space_item: byId("space_items"),
  space_occurrence: byId("space_occurrences"),
  trash_entry: byId("trash_entries"),
  work_unit: byId("work_units"),
} as const satisfies Record<string, IdKindSpec>;

export type IdKind = keyof typeof ID_KINDS;

/** The smallest string greater than every string that starts with `prefix`. */
function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/** Distinct ids the key names in one source, exactly or as a prefix, at most `MATCH_SAMPLE`. */
function sourceMatches(db: Db, source: IdSource, key: string, prefix: boolean, scope: readonly [string, string] | null): string[] {
  const needle = source.spell ? source.spell(key) : key;
  const where = prefix ? `${source.column} >= ? AND ${source.column} < ?` : `${source.column} = ?`;
  const params: string[] = prefix ? [needle, prefixUpperBound(needle)] : [needle];
  const scoped = scope ? ` AND ${scope[0]} = ?` : "";
  if (scope) params.push(scope[1]);
  return (db.prepare(
    `SELECT DISTINCT ${source.yields ?? source.column} AS value FROM ${source.table} WHERE ${where}${scoped} ORDER BY value LIMIT ${MATCH_SAMPLE}`,
  ).all(...params) as Array<{ value: string }>).map((row) => row.value);
}

function kindMatches(db: Db, spec: IdKindSpec, key: string, prefix: boolean, scope: readonly [string, string] | null): string[] {
  const ids = new Set<string>();
  for (const source of spec.sources) for (const id of sourceMatches(db, source, key, prefix, scope)) ids.add(id);
  return [...ids].sort();
}

function decide(ids: string[]): RefResolution {
  if (ids.length === 0) return NOT_FOUND;
  if (ids.length > 1) return { ok: false, error: "ambiguous", matches: ids.slice(0, MATCH_SAMPLE) };
  return { ok: true, id: ids[0] };
}

/**
 * Resolve an exact id, or a unique prefix of one, of the given kind. A kind
 * with a scope column resolves within `options.scope` when one is given.
 */
export function resolveId(db: Db, kind: IdKind, ref: string, options: { scope?: string } = {}): RefResolution {
  const spec: IdKindSpec = ID_KINDS[kind];
  if (options.scope !== undefined && !spec.scope) throw new Error(`${kind} references have no scope`);
  const scope = options.scope !== undefined && spec.scope ? [spec.scope, options.scope] as const : null;
  const key = ref.trim();
  if (!key) return NOT_FOUND;
  const exact = kindMatches(db, spec, key, false, scope);
  if (exact.length > 0) return decide(exact);
  if (key.length < (spec.minPrefix ?? MIN_PREFIX_LENGTH)) return NOT_FOUND;
  return decide(kindMatches(db, spec, key, true, scope));
}

/**
 * The shortest leading part of `key`, at least `minimum` long, that
 * `resolveId` maps back to `id`. `key` is the id's spelling without any typed
 * prefix its kind adds, and is the id itself by default.
 */
export function shortRef(db: Db, kind: IdKind, id: string, options: { key?: string; minimum?: number } = {}): string {
  const key = options.key ?? id;
  const spec: IdKindSpec = ID_KINDS[kind];
  const minimum = Math.max(options.minimum ?? 8, spec.minPrefix ?? MIN_PREFIX_LENGTH);
  for (let length = Math.min(minimum, key.length); length < key.length; length++) {
    const resolved = resolveId(db, kind, key.slice(0, length));
    if (resolved.ok && resolved.id === id) return key.slice(0, length);
  }
  return key;
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

// A conversation is named by its id, its provider session id, or a source's
// native session id. Several conversations (a session and its sidechains) can
// share one session id, and the conversation routes choose among them, so a
// prefix completes to the one conversation it names, else to the one alias.
const CONVERSATION_ALIASES: readonly IdSource[] = [
  { table: "conversations", column: "id" },
  { table: "conversations", column: "session_id", yields: "id" },
  { table: "conversation_sources", column: "native_session_id", yields: "conversation_id" },
];

function resolveConversationAliasRef(db: Db, ref: string): RefResolution {
  const key = ref.trim();
  if (CONVERSATION_ALIASES.some((source) => sourceMatches(db, source, key, false, null).length > 0)) return { ok: true, id: key };
  if (key.length < MIN_PREFIX_LENGTH) return NOT_FOUND;
  const conversations = new Set<string>();
  const aliases = new Set<string>();
  for (const source of CONVERSATION_ALIASES) {
    const rows = db.prepare(
      `SELECT DISTINCT ${source.column} AS alias, ${source.yields ?? source.column} AS id FROM ${source.table}
        WHERE ${source.column} >= ? AND ${source.column} < ? ORDER BY alias LIMIT ${MATCH_SAMPLE + 1}`,
    ).all(key, prefixUpperBound(key)) as Array<{ alias: string; id: string }>;
    for (const row of rows) {
      conversations.add(row.id);
      aliases.add(row.alias);
    }
  }
  if (conversations.size === 1) return { ok: true, id: [...conversations][0] };
  if (aliases.size === 1) return { ok: true, id: [...aliases][0] };
  return decide([...aliases].sort());
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
  conversation: ((ref) => resolveConversationAliasRef(getDb(), ref)) as RefResolver,
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
