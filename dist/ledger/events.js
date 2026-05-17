const LEDGER_EVENT_SSE_TYPES = {
    "issue.created": "ledger:issue:created",
    "issue.updated": "ledger:issue:updated",
    "comment.created": "ledger:comment:created",
    "label.updated": "ledger:label:updated",
    "relationship.upserted": "ledger:relationship:upserted",
    "outbox.updated": "ledger:outbox:updated",
    "conflict.created": "ledger:conflict:created",
    "external_ref.recorded": "ledger:external_ref:recorded",
    "work_unit.issue_linked": "ledger:work_unit:linked",
    "session.issue_linked": "ledger:session:linked",
    "auth_request.issue_linked": "ledger:auth:linked",
    "auth_request.completed": "ledger:auth:completed",
    "commit.issue_linked": "ledger:commit:linked",
};
export function ledgerSseTypeForEvent(eventType) {
    return LEDGER_EVENT_SSE_TYPES[eventType] ?? "ledger:event:created";
}
export function emitLedgerEvents(events, broadcaster) {
    for (const event of events) {
        broadcaster(ledgerSseTypeForEvent(event.event.event_type), event.payload);
        broadcaster("ledger:event:created", {
            id: event.event.id,
            entity_type: event.event.entity_type,
            entity_id: event.event.entity_id,
            event_type: event.event.event_type,
            source: event.event.source,
            occurred_at: event.event.occurred_at,
        });
    }
}
