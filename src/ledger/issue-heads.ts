import { createHash } from "node:crypto";
import type { Db } from "../db.js";

export interface LedgerIssueHead {
  issue_id: string;
  short_id: string;
  digest: string;
  subtree_digest: string;
  last_event_at: number | null;
  last_event_kind: string | null;
  subtree_last_event_at: number | null;
  subtree_last_event_kind: string | null;
}

export interface LedgerIssueHeadOptions {
  at?: number;
  // A manifest self-baseline is captured immediately before its own checkpoint
  // event. Pinned comparisons may omit that one establishing event without
  // changing the normal issue-head domain.
  excludeCheckpointId?: string;
}

interface IssueHeadEventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  occurred_at: number;
  observed_at: number;
}

/**
 * Collect the transitive parent_child descendant closure of `rootId`, including
 * the root itself. Traversal follows both the structured relationship-edge
 * graph (`ledger_relationship_edges` with `link_type = 'parent_child'`) and the
 * legacy relationship table (`ledger_issue_relationships` with
 * `relationship_type = 'parent_child'`). The recursive CTE uses `UNION` (not
 * `UNION ALL`), so cycles terminate and each descendant is returned once.
 */
export function collectSubtreeIssueIds(db: Db, rootId: string): string[] {
  const rows = db.prepare(
    `WITH RECURSIVE subtree(issue_id) AS (
       SELECT @root
       UNION
       SELECT edges.child_id
         FROM (
           SELECT source_issue_id AS parent_id, target_issue_id AS child_id
             FROM ledger_relationship_edges
            WHERE link_type = 'parent_child'
              AND target_entity_type = 'issue'
              AND deleted_at IS NULL
              AND target_issue_id IS NOT NULL
           UNION ALL
           SELECT source_issue_id AS parent_id, target_issue_id AS child_id
             FROM ledger_issue_relationships
            WHERE relationship_type = 'parent_child'
              AND deleted_at IS NULL
         ) edges
         JOIN subtree ON edges.parent_id = subtree.issue_id
     )
     SELECT issue_id FROM subtree`,
  ).all({ root: rootId }) as Array<{ issue_id: string }>;
  return rows.map((row) => row.issue_id);
}

function subtreeEventRows(
  db: Db,
  issueIds: string[],
  at: number | null,
  excludeCheckpointId: string | null,
): IssueHeadEventRow[] {
  if (issueIds.length === 0) return [];
  const params: Record<string, unknown> = { at, excludeCheckpointId };
  const keys = issueIds.map((id, index) => {
    const key = `sid${index}`;
    params[key] = id;
    return `@${key}`;
  });
  const inList = keys.join(", ");
  return db.prepare(
    `SELECT id, event_type, entity_type, entity_id, payload_json, occurred_at, observed_at
       FROM ledger_events
      WHERE (@at IS NULL OR occurred_at <= @at)
        AND (@excludeCheckpointId IS NULL
          OR entity_type != 'issue_checkpoint'
          OR entity_id != @excludeCheckpointId)
        AND (
          (entity_type = 'issue' AND entity_id IN (${inList}))
          OR (
            entity_type = 'comment'
            AND entity_id IN (
              SELECT id FROM ledger_comments
              WHERE issue_id IN (${inList}) AND deleted_at IS NULL
            )
          )
          OR (
            entity_type = 'issue_checkpoint'
            AND entity_id IN (
              SELECT id FROM ledger_issue_checkpoints
              WHERE issue_id IN (${inList})
            )
          )
          OR (
            entity_type = 'issue_relationship'
            AND entity_id IN (
              SELECT id FROM ledger_issue_relationships
              WHERE source_issue_id IN (${inList}) OR target_issue_id IN (${inList})
            )
          )
          OR (
            entity_type = 'relationship_edge'
            AND entity_id IN (
              SELECT id FROM ledger_relationship_edges
              WHERE source_issue_id IN (${inList}) OR target_issue_id IN (${inList})
            )
          )
        )
      ORDER BY occurred_at, observed_at, id`,
  ).all(params) as IssueHeadEventRow[];
}

export function getLedgerIssueHead(
  db: Db,
  issueId: string,
  options: LedgerIssueHeadOptions = {},
): LedgerIssueHead {
  const issue = db.prepare(
    "SELECT id, short_id FROM ledger_issues WHERE id = ? AND deleted_at IS NULL",
  ).get(issueId) as { id: string; short_id: string } | undefined;
  if (!issue) {
    throw new Error(`Ledger issue not found: ${issueId}`);
  }

  const at = options.at ?? null;
  const excludeCheckpointId = options.excludeCheckpointId ?? null;
  const events = db.prepare(
    `SELECT id, event_type, entity_type, entity_id, payload_json, occurred_at, observed_at
     FROM ledger_events
     WHERE (@at IS NULL OR occurred_at <= @at)
       AND (@excludeCheckpointId IS NULL
         OR entity_type != 'issue_checkpoint'
         OR entity_id != @excludeCheckpointId)
       AND (
          (entity_type = 'issue' AND entity_id = @issueId)
          OR (
            entity_type = 'comment'
            AND entity_id IN (
              SELECT id FROM ledger_comments
              WHERE issue_id = @issueId AND deleted_at IS NULL
            )
          )
          OR (
            entity_type = 'issue_checkpoint'
            AND entity_id IN (
              SELECT id FROM ledger_issue_checkpoints
              WHERE issue_id = @issueId
            )
          )
          OR (
            entity_type = 'issue_relationship'
            AND entity_id IN (
              SELECT id FROM ledger_issue_relationships
              WHERE source_issue_id = @issueId OR target_issue_id = @issueId
            )
          )
          OR (
            entity_type = 'relationship_edge'
            AND entity_id IN (
              SELECT id FROM ledger_relationship_edges
              WHERE source_issue_id = @issueId OR target_issue_id = @issueId
            )
          )
       )
     ORDER BY occurred_at, observed_at, id`,
  ).all({ issueId, at, excludeCheckpointId }) as IssueHeadEventRow[];

  const digest = createHash("sha256")
    .update(JSON.stringify(events))
    .digest("hex");
  const latest = events.at(-1);

  // Additive subtree digest: this issue's own head-relevant events plus those
  // of every transitive parent_child descendant, each event counted once. For a
  // leaf issue (no descendants) the descendant set is exactly {issueId}, so the
  // subtree query returns the same rows as the own-head query above and
  // subtree_digest equals digest.
  const subtreeIds = collectSubtreeIssueIds(db, issue.id);
  const subtreeEvents = subtreeEventRows(db, subtreeIds, at, excludeCheckpointId);
  const subtreeDigest = createHash("sha256")
    .update(JSON.stringify(subtreeEvents))
    .digest("hex");
  const subtreeLatest = subtreeEvents.at(-1);

  return {
    issue_id: issue.id,
    short_id: issue.short_id || issue.id.slice(0, 7),
    digest,
    subtree_digest: subtreeDigest,
    last_event_at: latest?.occurred_at ?? null,
    last_event_kind: latest?.event_type ?? null,
    subtree_last_event_at: subtreeLatest?.occurred_at ?? null,
    subtree_last_event_kind: subtreeLatest?.event_type ?? null,
  };
}
