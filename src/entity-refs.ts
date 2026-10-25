import { resolveConversationId } from "./conversations/identity.js";
import { getDb, type Db } from "./db.js";
import type { ResolvedClientIdentity } from "./server.js";
import { getOperatorId } from "./users/store.js";
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

/** A bound resolver for one route input, given the authenticated caller. */
export type RefResolver = (ref: string, caller: ResolvedClientIdentity | null) => RefResolution;

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
  /** A predicate on every source table, over one user id, naming the rows that user may read. */
  readonly readableBy?: string;
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
  binding: { ...byId("user_bindings"), readableBy: "user_id = ?" },
  body_revision: byId("ledger_body_revisions"),
  // Legacy Briefing ids store the `briefing:` typed-ref prefix themselves.
  briefing: {
    sources: [
      { table: "briefings", column: "id" },
      { table: "briefings", column: "id", spell: (key) => `briefing:${key}` },
    ],
    readableBy: "id IN (SELECT briefing_id FROM briefing_members WHERE user_id = ?)",
  },
  briefing_bundle: byId("briefing_bundles"),
  briefing_group: byId("briefing_groups"),
  briefing_round: byId("briefing_rounds"),
  checkpoint: byId("ledger_issue_checkpoints"),
  comment: byId("ledger_comments"),
  credential: { ...byId("user_credentials"), readableBy: "user_id = ?" },
  grant: { ...byId("permission_grants"), readableBy: "subject_type = 'user' AND subject_id = ?" },
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

/** A row predicate with its one parameter. */
type RowFilter = readonly [predicate: string, param: string];

/** One needle per key: an exact value, or a half-open prefix range. */
type Needle = readonly [key: string, low: string, high: string | null];

/**
 * The ids each needle names in one source, at most `MATCH_SAMPLE` per needle
 * in value order, from one statement for every needle.
 */
function sourceMatches(db: Db, source: IdSource, needles: readonly Needle[], filters: readonly RowFilter[], into: Map<string, Set<string>>): void {
  if (needles.length === 0) return;
  const exact = needles[0][2] === null;
  const match = exact
    ? `${source.column} = n.mandible_ref_low`
    : `${source.column} >= n.mandible_ref_low AND ${source.column} < n.mandible_ref_high`;
  const filtered = filters.map(([predicate]) => ` AND (${predicate})`).join("");
  const rows = db.prepare(
    `WITH n(mandible_ref_key, mandible_ref_low, mandible_ref_high) AS (
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)
     )
     SELECT mandible_ref_key AS key, value FROM (
       SELECT mandible_ref_key, value, ROW_NUMBER() OVER (PARTITION BY mandible_ref_key ORDER BY value) AS rank FROM (
         SELECT DISTINCT n.mandible_ref_key, ${source.yields ?? source.column} AS value
           FROM n JOIN ${source.table} ON ${match}${filtered}
       )
     ) WHERE rank <= ${MATCH_SAMPLE}`,
  ).all(JSON.stringify(needles), ...filters.map(([, param]) => param)) as Array<{ key: string; value: string }>;
  for (const row of rows) {
    let ids = into.get(row.key);
    if (!ids) into.set(row.key, ids = new Set());
    ids.add(row.value);
  }
}

function kindMatches(db: Db, spec: IdKindSpec, keys: readonly string[], prefix: boolean, filters: readonly RowFilter[]): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  for (const source of spec.sources) {
    const needles = keys.map((key): Needle => {
      const needle = source.spell ? source.spell(key) : key;
      return [key, needle, prefix ? prefixUpperBound(needle) : null];
    });
    sourceMatches(db, source, needles, filters, found);
  }
  return new Map([...found].map(([key, ids]) => [key, [...ids].sort()]));
}

function decide(ids: readonly string[] | undefined): RefResolution {
  if (!ids || ids.length === 0) return NOT_FOUND;
  if (ids.length > 1) return { ok: false, error: "ambiguous", matches: ids.slice(0, MATCH_SAMPLE) };
  return { ok: true, id: ids[0] };
}

/**
 * Resolve an exact id, or a unique prefix of one, of the given kind. A kind
 * with a scope column resolves within `options.scope` when one is given; a
 * kind with a read predicate resolves among the rows `options.reader` (a user
 * id) may read when one is given, so a refusal never names another's rows.
 */
export function resolveId(
  db: Db,
  kind: IdKind,
  ref: string,
  options: { scope?: string; reader?: string } = {},
): RefResolution {
  return resolveIds(db, kind, [ref], options).get(ref.trim()) ?? NOT_FOUND;
}

/**
 * `resolveId` for many refs at once, keyed by trimmed ref, in a fixed number
 * of statements however many refs there are.
 */
export function resolveIds(
  db: Db,
  kind: IdKind,
  refs: readonly string[],
  options: { scope?: string; reader?: string } = {},
): Map<string, RefResolution> {
  const spec: IdKindSpec = ID_KINDS[kind];
  if (options.scope !== undefined && !spec.scope) throw new Error(`${kind} references have no scope`);
  if (options.reader !== undefined && !spec.readableBy) throw new Error(`${kind} references have no read predicate`);
  const filters: RowFilter[] = [];
  if (options.scope !== undefined && spec.scope) filters.push([`${spec.scope} = ?`, options.scope]);
  if (options.reader !== undefined && spec.readableBy) filters.push([spec.readableBy, options.reader]);
  const keys = [...new Set(refs.map((ref) => ref.trim()))];
  const resolved = new Map<string, RefResolution>(keys.map((key) => [key, NOT_FOUND]));
  const nonEmpty = keys.filter(Boolean);
  const exact = kindMatches(db, spec, nonEmpty, false, filters);
  for (const [key, ids] of exact) resolved.set(key, decide(ids));
  const prefixKeys = nonEmpty.filter((key) => !exact.has(key) && key.length >= (spec.minPrefix ?? MIN_PREFIX_LENGTH));
  for (const [key, ids] of kindMatches(db, spec, prefixKeys, true, filters)) resolved.set(key, decide(ids));
  return resolved;
}

/** The reader a lookup is bounded by: none for the operator, else the caller (or nobody). */
export function refReader(db: Db, caller: { user_id: string } | null | undefined): string | undefined {
  if (caller && caller.user_id === getOperatorId(db)) return undefined;
  return caller?.user_id ?? "";
}

/**
 * The shortest leading part of `key`, at least `minimum` long, that
 * `resolveId` maps back to `id`. `key` is the id's spelling without any typed
 * prefix its kind adds, and is the id itself by default.
 */
export function shortRef(db: Db, kind: IdKind, id: string, options: { key?: string; minimum?: number } = {}): string {
  return shortRefs(db, kind, [{ id, key: options.key }], options)[0];
}

/**
 * `shortRef` for many entities of one kind, in order. Every entity still
 * looking for its length is tried in the same `resolveIds` round, so a page
 * costs a few rounds however many entities it holds.
 */
export function shortRefs(
  db: Db,
  kind: IdKind,
  entities: ReadonlyArray<{ id: string; key?: string }>,
  options: { minimum?: number } = {},
): string[] {
  const spec: IdKindSpec = ID_KINDS[kind];
  const minimum = Math.max(options.minimum ?? 8, spec.minPrefix ?? MIN_PREFIX_LENGTH);
  const searches = entities.map(({ id, key = id }) => ({ id, key, length: Math.min(minimum, key.length), short: key }));
  let pending = searches.filter((search) => search.length < search.key.length);
  while (pending.length > 0) {
    const resolved = resolveIds(db, kind, pending.map((search) => search.key.slice(0, search.length)));
    pending = pending.filter((search) => {
      const candidate = search.key.slice(0, search.length);
      const resolution = resolved.get(candidate.trim());
      if (resolution?.ok && resolution.id === search.id) {
        search.short = candidate;
        return false;
      }
      search.length += 1;
      return search.length < search.key.length;
    });
  }
  return searches.map((search) => search.short);
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
  const exact = db.prepare("SELECT id FROM conversations WHERE id = ?").get(key) as { id: string } | undefined;
  if (exact) return { ok: true, id: resolveConversationId(db, exact.id) };
  if (kindMatches(db, { sources: CONVERSATION_ALIASES }, [key], false, []).has(key)) return { ok: true, id: key };
  if (key.length < MIN_PREFIX_LENGTH) return NOT_FOUND;
  const conversations = new Set<string>();
  const aliases = new Set<string>();
  for (const source of CONVERSATION_ALIASES) {
    const rows = db.prepare(
      `SELECT DISTINCT ${source.column} AS alias, ${source.yields ?? source.column} AS id FROM ${source.table}
        WHERE ${source.column} >= ? AND ${source.column} < ? ORDER BY alias LIMIT ${MATCH_SAMPLE + 1}`,
    ).all(key, prefixUpperBound(key)) as Array<{ alias: string; id: string }>;
    for (const row of rows) {
      conversations.add(resolveConversationId(db, row.id));
      aliases.add(row.alias);
    }
  }
  if (conversations.size === 1) return { ok: true, id: [...conversations][0] };
  if (aliases.size === 1) return { ok: true, id: [...aliases][0] };
  return decide([...aliases].sort());
}

const bind = (kind: IdKind): RefResolver => (ref) => resolveId(getDb(), kind, ref);
const bindReadable = (kind: IdKind): RefResolver => (ref, caller) => {
  const db = getDb();
  return resolveId(db, kind, ref, { reader: refReader(db, caller) });
};

/** Route-input resolvers, bound to the daemon database, for `RouteOptions.refs`. */
export const entityRefs = {
  authRequest: bind("auth_request"),
  authClearance: bind("auth_clearance"),
  binding: bindReadable("binding"),
  bodyRevision: bind("body_revision"),
  briefingRound: bind("briefing_round"),
  checkpoint: bind("checkpoint"),
  comment: ((ref) => resolveCommentRef(getDb(), ref)) as RefResolver,
  conversation: ((ref) => resolveConversationAliasRef(getDb(), ref)) as RefResolver,
  credential: bindReadable("credential"),
  grant: bindReadable("grant"),
  session: ((ref) => resolveSessionAliasRef(getDb(), ref)) as RefResolver,
  spaceBlock: bind("space_block"),
  spaceEdge: bind("space_edge"),
  spaceItem: bind("space_item"),
  spaceOccurrence: bind("space_occurrence"),
  trashEntry: bind("trash_entry"),
  workUnit: bind("work_unit"),
} satisfies Record<string, RefResolver>;
