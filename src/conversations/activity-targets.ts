import * as z from 'zod';
import type { Db } from '../db.js';
import { PARSER_CAPABILITIES } from '../parsers/capabilities.js';
import type { ConversationSource } from '../parsers/types.js';
import { maskUnverifiedCandidates } from '../credential-leak-scan.js';
import { activityTargetKey, type ActivityTarget, type ActivityTargetResolution } from '../presentation/activity-targets.js';

const identity = z.string().min(1).max(1024);
const provider = z.custom<ConversationSource>(value => PARSER_CAPABILITIES.some(item => item.source === value));
export const activityTargetsSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread'), provider, sessionId: identity }),
  z.object({ kind: z.literal('pending-thread'), provider: z.literal('codex'), clientThreadId: identity }),
  z.object({ kind: z.literal('subagent'), provider, parentSessionId: identity, agentId: identity }),
])).min(1).max(64);

/** Resolve exact provider identities in one metadata-only snapshot. */
export function resolveActivityTargets(db: Db, targets: readonly ActivityTarget[]): ActivityTargetResolution[] {
  const rows = db.prepare(`
    WITH requested AS (
      SELECT CAST(key AS INTEGER) AS ordinal,
        json_extract(value, '$.kind') AS kind, json_extract(value, '$.provider') AS provider,
        json_extract(value, '$.sessionId') AS session_id,
        json_extract(value, '$.parentSessionId') AS parent_session_id,
        json_extract(value, '$.agentId') AS agent_id
      FROM json_each(?)
    ), candidates AS (
      SELECT r.ordinal, c.id, c.title FROM requested r
      JOIN conversations c ON c.session_id = r.session_id AND c.source = r.provider
      WHERE r.kind = 'thread' AND (r.provider <> 'claude_code' OR c.agent_id IS NULL)
      UNION
      SELECT r.ordinal, c.id, c.title FROM requested r
      JOIN conversation_sources s ON s.native_session_id = r.session_id
      JOIN conversations c ON c.id = s.conversation_id AND c.source = r.provider
      WHERE r.kind = 'thread' AND (r.provider <> 'claude_code' OR c.agent_id IS NULL)
      UNION
      SELECT r.ordinal, c.id, c.title FROM requested r
      JOIN conversations c ON (c.agent_id = r.agent_id OR c.session_id = r.agent_id) AND c.source = r.provider
      LEFT JOIN conversations parent ON parent.id = c.parent_conversation_id
      WHERE r.kind = 'subagent' AND (c.parent_session_id = r.parent_session_id
        OR c.session_id = r.parent_session_id OR parent.session_id = r.parent_session_id)
    ) SELECT ordinal, id, title FROM candidates
  `).all(JSON.stringify(targets)) as Array<{ ordinal: number; id: string; title: string }>;
  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = grouped.get(row.ordinal) ?? [];
    group.push(row);
    grouped.set(row.ordinal, group);
  }
  return targets.map((target, index) => {
    const key = activityTargetKey(target);
    const candidates = grouped.get(index) ?? [];
    if (candidates.length !== 1) return { key, status: candidates.length ? 'ambiguous' : 'not_found' };
    return { key, status: 'resolved', conversationId: candidates[0].id,
      title: maskUnverifiedCandidates(candidates[0].title).text };
  });
}
