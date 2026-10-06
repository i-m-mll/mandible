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

function placeholders(values: string[], prefix: string): { sql: string; bindings: Record<string, unknown> } {
  const bindings: Record<string, unknown> = {};
  const keys = values.map((value, index) => {
    const key = `${prefix}${index}`;
    bindings[key] = value;
    return `:${key}`;
  });
  return { sql: keys.join(", "), bindings };
}

function compareHeadEvents(a: IssueHeadEventRow, b: IssueHeadEventRow): number {
  // SQLite BINARY orders UTF-8 bytes; UTF-16 and locale comparisons differ.
  return a.occurred_at - b.occurred_at
    || a.observed_at - b.observed_at
    || Buffer.compare(Buffer.from(a.id, "utf8"), Buffer.from(b.id, "utf8"));
}

function digestHeadEvents(events: IssueHeadEventRow[]): {
  digest: string;
  last: IssueHeadEventRow | undefined;
} {
  const digest = createHash("sha256")
    .update(JSON.stringify(events))
    .digest("hex");
  return { digest, last: events.at(-1) };
}

export function batchLedgerIssueHeads(
  db: Db,
  issueIds: string[],
  options: LedgerIssueHeadOptions = {},
): Map<string, LedgerIssueHead> {
  if (issueIds.length === 0) return new Map();
  const { sql, bindings } = placeholders(issueIds, "issue");
  const issues = db.prepare(
    `SELECT id, short_id FROM ledger_issues WHERE id IN (${sql}) AND deleted_at IS NULL`,
  ).all(bindings) as Array<{ id: string; short_id: string }>;

  // One recursive closure query for every requested root at once: map each root
  // to its transitive parent_child descendant set (including itself), following
  // both the structured edge graph and the legacy relationship table. `UNION`
  // makes the traversal cycle-safe and each (root, descendant) pair unique.
  const descendantsByRoot = new Map<string, string[]>();
  const allIds = new Set<string>(issueIds);
  const closureRows = db.prepare(
    `WITH RECURSIVE subtree(root_id, issue_id) AS (
       SELECT id, id FROM ledger_issues WHERE id IN (${sql})
       UNION
       SELECT s.root_id, edges.child_id
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
         JOIN subtree s ON edges.parent_id = s.issue_id
     )
     SELECT root_id, issue_id FROM subtree`,
  ).all(bindings) as Array<{ root_id: string; issue_id: string }>;
  for (const row of closureRows) {
    const group = descendantsByRoot.get(row.root_id) ?? [];
    group.push(row.issue_id);
    descendantsByRoot.set(row.root_id, group);
    allIds.add(row.issue_id);
  }

  // Fetch head-relevant events once for the union of every subtree, keyed by the
  // issue that owns each event. Relationship events are attached to both
  // endpoints, so they can appear under two issue keys; the subtree assembly
  // below de-duplicates by event id.
  const allIdList = Array.from(allIds);
  const { sql: allSql, bindings: allBindings } = placeholders(allIdList, "sub");
  const eventFilters: string[] = [];
  if (options.at != null) {
    allBindings.at = options.at;
    eventFilters.push("occurred_at <= @at");
  }
  if (options.excludeCheckpointId != null) {
    allBindings.excludeCheckpointId = options.excludeCheckpointId;
    eventFilters.push("(entity_type != 'issue_checkpoint' OR entity_id != @excludeCheckpointId)");
  }
  const rowsByIssue = new Map<string, IssueHeadEventRow[]>();
  const seenByIssue = new Map<string, Set<string>>();
  for (const id of allIdList) {
    rowsByIssue.set(id, []);
    seenByIssue.set(id, new Set<string>());
  }

  const appendRows = (rows: Array<Record<string, unknown>>): void => {
    for (const row of rows) {
      const issueId = String(row.issue_id ?? "");
      const group = rowsByIssue.get(issueId);
      const seen = seenByIssue.get(issueId);
      if (!group || !seen) continue;
      // Self-edge events arrive through both endpoints but count once per issue.
      const eventId = String(row.id ?? "");
      if (seen.has(eventId)) continue;
      seen.add(eventId);
      group.push({
        id: eventId,
        event_type: String(row.event_type ?? ""),
        entity_type: String(row.entity_type ?? ""),
        entity_id: String(row.entity_id ?? ""),
        payload_json: String(row.payload_json ?? ""),
        occurred_at: Number(row.occurred_at ?? 0),
        observed_at: Number(row.observed_at ?? 0),
      });
    }
  };

  appendRows(db.prepare(
    `WITH head_events AS (
     SELECT e.entity_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
      WHERE e.entity_type = 'issue' AND e.entity_id IN (${allSql})
     UNION ALL
     SELECT c.issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
       JOIN ledger_comments c ON c.id = e.entity_id
      WHERE e.entity_type = 'comment' AND c.deleted_at IS NULL AND c.issue_id IN (${allSql})
     UNION ALL
     SELECT c.issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
       JOIN ledger_issue_checkpoints c ON c.id = e.entity_id
      WHERE e.entity_type = 'issue_checkpoint' AND c.issue_id IN (${allSql})
     UNION ALL
     SELECT r.source_issue_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
       JOIN ledger_issue_relationships r ON r.id = e.entity_id
      WHERE e.entity_type = 'issue_relationship' AND r.source_issue_id IN (${allSql})
     UNION ALL
     SELECT r.target_issue_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
       JOIN ledger_issue_relationships r ON r.id = e.entity_id
      WHERE e.entity_type = 'issue_relationship' AND r.target_issue_id IN (${allSql})
     UNION ALL
     SELECT r.source_issue_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
       JOIN ledger_relationship_edges r ON r.id = e.entity_id
      WHERE e.entity_type = 'relationship_edge' AND r.source_issue_id IN (${allSql})
     UNION ALL
     SELECT r.target_issue_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
       JOIN ledger_relationship_edges r ON r.id = e.entity_id
      WHERE e.entity_type = 'relationship_edge' AND r.target_issue_id IN (${allSql})
     )
     SELECT * FROM head_events
      ${eventFilters.length ? `WHERE ${eventFilters.join(" AND ")}` : ""}`,
  ).all(allBindings) as Array<Record<string, unknown>>);

  const heads = new Map<string, LedgerIssueHead>();
  for (const issue of issues) {
    const ownEvents = (rowsByIssue.get(issue.id) ?? []).slice().sort(compareHeadEvents);
    const own = digestHeadEvents(ownEvents);

    const descendantIds = descendantsByRoot.get(issue.id) ?? [issue.id];
    const seen = new Set<string>();
    const subtreeEvents: IssueHeadEventRow[] = [];
    for (const descendantId of descendantIds) {
      for (const event of rowsByIssue.get(descendantId) ?? []) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        subtreeEvents.push(event);
      }
    }
    subtreeEvents.sort(compareHeadEvents);
    const subtree = digestHeadEvents(subtreeEvents);

    heads.set(issue.id, {
      issue_id: issue.id,
      short_id: issue.short_id || issue.id.slice(0, 7),
      digest: own.digest,
      subtree_digest: subtree.digest,
      last_event_at: own.last ? own.last.occurred_at : null,
      last_event_kind: own.last ? own.last.event_type : null,
      subtree_last_event_at: subtree.last ? subtree.last.occurred_at : null,
      subtree_last_event_kind: subtree.last ? subtree.last.event_type : null,
    });
  }
  return heads;
}

export function getLedgerIssueHead(
  db: Db,
  issueId: string,
  options: LedgerIssueHeadOptions = {},
): LedgerIssueHead {
  const head = batchLedgerIssueHeads(db, [issueId], options).get(issueId);
  if (!head) throw new Error(`Ledger issue not found: ${issueId}`);
  return head;
}
