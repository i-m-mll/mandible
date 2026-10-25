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
  // Issue d9e59e8 — the head includes each linked work unit's lifecycle so a
  // coordinator notices a child gaining, committing, or resolving a lane. The
  // auth action staleness guard excludes it: a merge resolves its own work
  // unit, which must not make the merge's staged issue actions look stale.
  excludeWorkUnits?: boolean;
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

/**
 * A head event with the two derived forms every digest and sort needs, built
 * once: an event is shared by its issue's own digest and by the subtree
 * digest of every ancestor in the batch.
 */
interface HeadEvent {
  row: IssueHeadEventRow;
  json: string;
  idBytes: Buffer;
}

function headEvent(row: IssueHeadEventRow): HeadEvent {
  return { row, json: JSON.stringify(row), idBytes: Buffer.from(row.id, "utf8") };
}

function compareHeadEvents(a: HeadEvent, b: HeadEvent): number {
  // SQLite BINARY orders UTF-8 bytes; UTF-16 and locale comparisons differ.
  return a.row.occurred_at - b.row.occurred_at
    || a.row.observed_at - b.row.observed_at
    || Buffer.compare(a.idBytes, b.idBytes);
}

/** The SHA-256 of `JSON.stringify` of the event rows, from their cached JSON. */
function digestHeadEvents(events: HeadEvent[]): {
  digest: string;
  last: IssueHeadEventRow | undefined;
} {
  const digest = createHash("sha256")
    .update(`[${events.map((event) => event.json).join(",")}]`)
    .digest("hex");
  return { digest, last: events.at(-1)?.row };
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
       SELECT s.root_id, edge.target_issue_id
         FROM subtree s
         CROSS JOIN ledger_relationship_edges edge
           ON edge.source_issue_id = s.issue_id
          AND edge.deleted_at IS NULL
        WHERE +edge.link_type = 'parent_child'
          AND +edge.target_entity_type = 'issue'
          AND edge.target_issue_id IS NOT NULL
       UNION
       SELECT s.root_id, rel.target_issue_id
         FROM subtree s
         CROSS JOIN ledger_issue_relationships rel
           ON rel.source_issue_id = s.issue_id
        WHERE +rel.relationship_type = 'parent_child'
          AND rel.deleted_at IS NULL
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
  const rowsByIssue = new Map<string, HeadEvent[]>();
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
      group.push(headEvent({
        id: eventId,
        event_type: String(row.event_type ?? ""),
        entity_type: String(row.entity_type ?? ""),
        entity_id: String(row.entity_id ?? ""),
        payload_json: String(row.payload_json ?? ""),
        occurred_at: Number(row.occurred_at ?? 0),
        observed_at: Number(row.observed_at ?? 0),
      }));
    }
  };

  appendRows(db.prepare(
    `WITH head_events AS (
     SELECT e.entity_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
      WHERE e.entity_type = 'issue' AND e.entity_id IN (${allSql})
     UNION ALL
     SELECT c.issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_comments c
       CROSS JOIN ledger_events e ON e.entity_type = 'comment' AND e.entity_id = c.id
      WHERE c.deleted_at IS NULL AND c.issue_id IN (${allSql})
     UNION ALL
     SELECT c.issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_issue_checkpoints c
       CROSS JOIN ledger_events e ON e.entity_type = 'issue_checkpoint' AND e.entity_id = c.id
      WHERE c.issue_id IN (${allSql})
     UNION ALL
     SELECT r.source_issue_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_issue_relationships r
       CROSS JOIN ledger_events e ON e.entity_type = 'issue_relationship' AND e.entity_id = r.id
      WHERE r.source_issue_id IN (${allSql})
     UNION ALL
     SELECT r.target_issue_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_issue_relationships r
       CROSS JOIN ledger_events e ON e.entity_type = 'issue_relationship' AND e.entity_id = r.id
      WHERE r.target_issue_id IN (${allSql})
     UNION ALL
     SELECT r.source_issue_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_relationship_edges r
       CROSS JOIN ledger_events e ON e.entity_type = 'relationship_edge' AND e.entity_id = r.id
      WHERE r.source_issue_id IN (${allSql})
     UNION ALL
     SELECT r.target_issue_id AS issue_id, e.id, e.event_type, e.entity_type, e.entity_id, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_relationship_edges r
       CROSS JOIN ledger_events e ON e.entity_type = 'relationship_edge' AND e.entity_id = r.id
      WHERE r.target_issue_id IN (${allSql})
     )
     SELECT * FROM head_events
      ${eventFilters.length ? `WHERE ${eventFilters.join(" AND ")}` : ""}`,
  ).all(allBindings) as Array<Record<string, unknown>>);

  if (!options.excludeWorkUnits) {
    appendRows(workUnitHeadRows(db, allIdList, options.at));
  }

  const heads = new Map<string, LedgerIssueHead>();
  for (const issue of issues) {
    const ownEvents = (rowsByIssue.get(issue.id) ?? []).slice().sort(compareHeadEvents);
    const own = digestHeadEvents(ownEvents);

    const descendantIds = descendantsByRoot.get(issue.id) ?? [issue.id];
    const seen = new Set<string>();
    const subtreeEvents: HeadEvent[] = [];
    for (const descendantId of descendantIds) {
      for (const event of rowsByIssue.get(descendantId) ?? []) {
        if (seen.has(event.row.id)) continue;
        seen.add(event.row.id);
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

/**
 * Work-unit lifecycle facts as head rows: a claim at `created_at`, a commit at
 * `activated_at`, and a terminal state at `resolved_at`. Abandonment does not
 * always record a time, so it falls back to the latest known transition.
 */
function workUnitHeadRows(db: Db, issueIds: string[], at: number | undefined): Array<Record<string, unknown>> {
  if (issueIds.length === 0) return [];
  const { sql, bindings } = placeholders(issueIds, "wu");
  const units = db.prepare(
    `SELECT id, ledger_issue_id, branch, state, created_at, activated_at, resolved_at
       FROM work_units
      WHERE ledger_issue_id IN (${sql})`,
  ).all(bindings) as Array<{
    id: string;
    ledger_issue_id: string;
    branch: string | null;
    state: string;
    created_at: number;
    activated_at: number | null;
    resolved_at: number | null;
  }>;
  const rows: Array<Record<string, unknown>> = [];
  const push = (unit: (typeof units)[number], transition: string, occurredAt: number, payload: Record<string, unknown>) => {
    if (at != null && occurredAt > at) return;
    rows.push({
      issue_id: unit.ledger_issue_id,
      id: `work_unit:${unit.id}:${transition}`,
      event_type: `work_unit.${transition}`,
      entity_type: "work_unit",
      entity_id: unit.id,
      payload_json: JSON.stringify(payload),
      occurred_at: occurredAt,
      observed_at: occurredAt,
    });
  };
  for (const unit of units) {
    push(unit, "claimed", unit.created_at, { branch: unit.branch });
    if (unit.activated_at != null) push(unit, "committed", unit.activated_at, {});
    if (unit.state === "resolved" || unit.state === "abandoned") {
      push(unit, unit.state, unit.resolved_at ?? unit.activated_at ?? unit.created_at, {});
    }
  }
  return rows;
}

/** One issue's head from a batch, refusing an issue the batch did not find. */
export function requireLedgerIssueHead(heads: Map<string, LedgerIssueHead>, issueId: string): LedgerIssueHead {
  const head = heads.get(issueId);
  if (!head) throw new Error(`Ledger issue not found: ${issueId}`);
  return head;
}

export function getLedgerIssueHead(
  db: Db,
  issueId: string,
  options: LedgerIssueHeadOptions = {},
): LedgerIssueHead {
  return requireLedgerIssueHead(batchLedgerIssueHeads(db, [issueId], options), issueId);
}

/**
 * The digest the auth action staleness guard compares: issue-entity events only,
 * without work-unit lifecycle (see `excludeWorkUnits`).
 */
export function getLedgerIssueContentDigest(db: Db, issueId: string): string {
  return getLedgerIssueHead(db, issueId, { excludeWorkUnits: true }).digest;
}
