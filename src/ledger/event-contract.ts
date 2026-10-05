// Shared ledger wire vocabulary. This module contains no database or server code.
export const LEDGER_EVENT_SSE_TYPES = Object.freeze({
  "issue.created": "ledger:issue:created",
  "issue.updated": "ledger:issue:updated",
  "issue.work_notes_updated": "ledger:issue:updated",
  "issue.closed": "ledger:issue:closed",
  "issue.reopened": "ledger:issue:reopened",
  "comment.created": "ledger:comment:created",
  "comment.updated": "ledger:comment:updated",
  "label.updated": "ledger:label:updated",
  "relationship.upserted": "ledger:relationship:upserted",
  "relationship.deleted": "ledger:relationship:deleted",
  "relationship.added": "ledger:relationship:added",
  "relationship.removed": "ledger:relationship:removed",
  "outbox.updated": "ledger:outbox:updated",
  "conflict.created": "ledger:conflict:created",
  "external_ref.recorded": "ledger:external_ref:recorded",
  "work_unit.issue_linked": "ledger:work_unit:linked",
  "session.issue_linked": "ledger:session:linked",
  "auth_request.issue_linked": "ledger:auth:linked",
  "auth_request.completed": "ledger:auth:completed",
  "commit.issue_linked": "ledger:commit:linked",
} as const);

export const LEDGER_EVENT_CREATED = "ledger:event:created" as const;
export const LEDGER_EVENT_VALUES = Object.freeze([
  ...Object.values(LEDGER_EVENT_SSE_TYPES), LEDGER_EVENT_CREATED,
]);
export type LedgerDomainEvent = (typeof LEDGER_EVENT_VALUES)[number];

export function ledgerSseTypeForEvent(eventType: string): LedgerDomainEvent {
  return Object.hasOwn(LEDGER_EVENT_SSE_TYPES, eventType)
    ? LEDGER_EVENT_SSE_TYPES[eventType as keyof typeof LEDGER_EVENT_SSE_TYPES]
    : LEDGER_EVENT_CREATED;
}
