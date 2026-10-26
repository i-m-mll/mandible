import { LEDGER_EVENT_CREATED, ledgerSseTypeForEvent, type LedgerDomainEvent } from "./event-contract.js";
export { ledgerSseTypeForEvent } from "./event-contract.js";
import type { LedgerEvent } from "./types.js";
import { requestOriginFromMetadata } from "../request-origin.js";

export interface LedgerSsePayload {
  event: LedgerEvent;
  payload: Record<string, unknown>;
}

export type LedgerBroadcaster = (type: LedgerDomainEvent, data: Record<string, unknown>) => void;

export function emitLedgerEvents(
  events: LedgerSsePayload[],
  broadcaster: LedgerBroadcaster,
): void {
  for (const event of events) {
    broadcaster(ledgerSseTypeForEvent(event.event.event_type), event.payload);
    broadcaster(LEDGER_EVENT_CREATED, {
      id: event.event.id,
      entity_type: event.event.entity_type,
      entity_id: event.event.entity_id,
      event_type: event.event.event_type,
      // Legacy provenance plus the resolved user principal (umbrella 8e2e8b2 /
      // issue 92813cc) so live read surfaces can attribute events to a user.
      actor_id: event.event.actor_id,
      actor_type: event.event.actor_type,
      actor_user_id: event.event.actor_user_id ?? null,
      evidence_method: event.event.evidence_method ?? null,
      request_origin: requestOriginFromMetadata(JSON.parse(event.event.payload_json)),
      source: event.event.source,
      occurred_at: event.event.occurred_at,
    });
  }
}
