// What Mandible knows about one agent session, whatever provider runs it and
// whether or not a process attachment (`sessions` row) exists: identity and
// liveness from the alias resolver, facts from the indexed conversation, and
// the process attachment when there is one. Every session list — the overview,
// its children, the issue session lists — reads sessions through this module.

import type { SessionDescendant, SessionProcess, SessionSummary } from "./contracts.js";
import type { Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { childrenOfSessionSql } from "./conversation-lineage.js";
import {
  resolveSessionAlias,
  sessionAliasIds,
  sessionLinkKey,
  type SessionAliasResolution,
} from "./session-liveness.js";

/**
 * SQL predicate selecting, as `alias`, the conversation rows that record the
 * session keyed at `keySql`: rows of that provider session, less its in-session
 * children, or the row of the in-session child (a Claude subagent) whose agent
 * id is the key.
 */
export function sessionConversationsSql(alias: string, keySql = "?"): string {
  return `((${alias}.session_id = ${keySql} AND ${alias}.parent_session_id IS NOT ${alias}.session_id)
    OR (${alias}.agent_id = ${keySql} AND ${alias}.parent_session_id = ${alias}.session_id))`;
}

interface ConversationFacts {
  id: string;
  title: string | null;
  agent_id: string | null;
  cwd: string | null;
  branch: string | null;
  started_at: string | null;
  ended_at: string | null;
}

function conversationFacts(db: Db, key: string): ConversationFacts | null {
  if (!tableExists(db, "conversations")) return null;
  const row = db.prepare(`
    SELECT c.id, NULLIF(c.title, '') AS title, c.agent_id, c.cwd, c.branch, c.started_at, c.ended_at
      FROM conversations c
     WHERE ${sessionConversationsSql("c", "?1")}
     ORDER BY c.is_sidechain ASC, c.started_at ASC, c.id ASC
     LIMIT 1
  `).get(key) as ConversationFacts | undefined;
  return row ?? null;
}

function processRow(db: Db, sessionId: string | null): SessionProcess | null {
  if (!sessionId || !tableExists(db, "sessions")) return null;
  const row = db.prepare(`
    SELECT id, app, status, pid, task, agent_type, terminal, multiplexer, nav_session, nav_tab,
           nav_pane_id, worktree, cwd, branch, created_at, ended_at, last_active, owner_user_id
      FROM sessions WHERE id = ?
  `).get(sessionId) as (SessionProcess & { cwd: string | null; branch: string | null }) | undefined;
  return row ?? null;
}

/** Summarize a resolved session. */
export function summarizeResolvedSession(db: Db, resolution: SessionAliasResolution): SessionSummary {
  const id = sessionLinkKey(resolution);
  const conversation = conversationFacts(db, id);
  const process = processRow(db, resolution.mandible_session_id) as
    (SessionProcess & { cwd: string | null; branch: string | null }) | null;
  const providerAgent = conversation?.agent_id && conversation.agent_id !== id ? conversation.agent_id : null;
  return {
    id,
    provider: resolution.provider,
    provider_session_id: resolution.provider_session_id,
    liveness: resolution.liveness,
    conversation_id: conversation?.id ?? null,
    title: conversation?.title ?? process?.task ?? null,
    agent: process?.agent_type ?? providerAgent,
    cwd: conversation?.cwd ?? process?.cwd ?? null,
    branch: conversation?.branch ?? process?.branch ?? null,
    started_at: conversation?.started_at ?? process?.created_at ?? null,
    ended_at: conversation?.ended_at ?? process?.ended_at ?? null,
    last_activity: resolution.last_activity,
    process: process ? withoutLocation(process) : null,
  };
}

function withoutLocation(row: SessionProcess & { cwd: string | null; branch: string | null }): SessionProcess {
  const { cwd: _cwd, branch: _branch, ...process } = row;
  return process;
}

/**
 * Summarize the session a stored key names (an issue link, a work-unit holder).
 * A key Mandible cannot resolve is still listed, with no provider and no
 * liveness signal.
 */
export function summarizeSessionKey(db: Db, key: string): SessionSummary {
  const resolution = resolveSessionAlias(db, key);
  if (resolution) return summarizeResolvedSession(db, resolution);
  return {
    id: key,
    provider: null,
    provider_session_id: null,
    liveness: "stopped",
    conversation_id: null,
    title: null,
    agent: null,
    cwd: null,
    branch: null,
    started_at: null,
    ended_at: null,
    last_activity: null,
    process: null,
  };
}

export const SESSION_DESCENDANT_DEPTH_LIMIT = 5;
export const SESSION_DESCENDANT_COUNT_LIMIT = 200;


/**
 * The sessions created by `rootKey`'s session, and theirs, from conversation
 * lineage, breadth first, bounded in depth and count. An in-session child has
 * no children of its own.
 */
export function sessionDescendants(
  db: Db,
  rootKey: string,
): { items: SessionDescendant[]; truncated: boolean } {
  if (!tableExists(db, "conversations")) return { items: [], truncated: false };
  const children = db.prepare(`
    SELECT CASE WHEN c.parent_session_id = c.session_id THEN c.agent_id ELSE c.session_id END AS child_key,
           c.parent_session_id = c.session_id AS in_session
      FROM conversations c
     WHERE ${childrenOfSessionSql("c")}
     ORDER BY c.started_at ASC, c.id ASC
  `);
  const seen = new Set<string>([rootKey]);
  const items: SessionDescendant[] = [];
  let frontier = [rootKey];
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const parentKey of frontier) {
      const rows = children.all(parentKey) as Array<{ child_key: string | null; in_session: number }>;
      for (const row of rows) {
        if (!row.child_key || seen.has(row.child_key)) continue;
        if (depth > SESSION_DESCENDANT_DEPTH_LIMIT || items.length >= SESSION_DESCENDANT_COUNT_LIMIT) {
          return { items, truncated: true };
        }
        seen.add(row.child_key);
        items.push({ ...summarizeSessionKey(db, row.child_key), parent_id: parentKey, depth });
        if (!row.in_session) next.push(row.child_key);
      }
    }
    frontier = next;
  }
  return { items, truncated: false };
}

/** Every id a session and its descendants are recorded under, for keyed reads. */
export function sessionFamilyAliasIds(
  resolution: SessionAliasResolution,
  descendants: SessionDescendant[],
): string[] {
  const ids = new Set(sessionAliasIds(resolution));
  for (const child of descendants) {
    ids.add(child.id);
    if (child.process) ids.add(child.process.id);
  }
  return [...ids];
}
