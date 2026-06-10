import { createHash } from "node:crypto";
import type { Db } from "../db.js";

export interface LedgerIssueHead {
  issue_id: string;
  short_id: string;
  digest: string;
  last_event_at: number | null;
  last_event_kind: string | null;
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

export function getLedgerIssueHead(db: Db, issueId: string): LedgerIssueHead {
  const issue = db.prepare(
    "SELECT id, short_id FROM ledger_issues WHERE id = ? AND deleted_at IS NULL",
  ).get(issueId) as { id: string; short_id: string } | undefined;
  if (!issue) {
    throw new Error(`Ledger issue not found: ${issueId}`);
  }

  const events = db.prepare(
    `SELECT id, event_type, entity_type, entity_id, payload_json, occurred_at, observed_at
     FROM ledger_events
     WHERE (entity_type = 'issue' AND entity_id = @issueId)
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
     ORDER BY occurred_at, observed_at, id`,
  ).all({ issueId }) as IssueHeadEventRow[];

  const digest = createHash("sha256")
    .update(JSON.stringify(events))
    .digest("hex");
  const latest = events.at(-1);

  return {
    issue_id: issue.id,
    short_id: issue.short_id || issue.id.slice(0, 7),
    digest,
    last_event_at: latest?.occurred_at ?? null,
    last_event_kind: latest?.event_type ?? null,
  };
}
