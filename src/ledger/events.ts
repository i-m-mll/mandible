import type { LedgerEvent } from "./types.js";

const LEDGER_EVENT_SSE_TYPES: Record<string, string> = {
  "issue.created": "ledger:issue:created",
  "issue.updated": "ledger:issue:updated",
  "comment.created": "ledger:comment:created",
  "label.updated": "ledger:label:updated",
  "relationship.upserted": "ledger:relationship:upserted",
  "outbox.updated": "ledger:outbox:updated",
  "conflict.created": "ledger:conflict:created",
  "external_ref.recorded": "ledger:external_ref:recorded",
};

export interface LedgerSsePayload {
  event: LedgerEvent;
  payload: Record<string, unknown>;
}

export type LedgerBroadcaster = (type: string, data: unknown) => void;

export function ledgerSseTypeForEvent(eventType: string): string {
  return LEDGER_EVENT_SSE_TYPES[eventType] ?? "ledger:event:created";
}

export function emitLedgerEvents(
  events: LedgerSsePayload[],
  broadcaster: LedgerBroadcaster,
): void {
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
