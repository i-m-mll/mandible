import type { LedgerEvent } from "./types.js";
export interface LedgerSsePayload {
    event: LedgerEvent;
    payload: Record<string, unknown>;
}
export type LedgerBroadcaster = (type: string, data: unknown) => void;
export declare function ledgerSseTypeForEvent(eventType: string): string;
export declare function emitLedgerEvents(events: LedgerSsePayload[], broadcaster: LedgerBroadcaster): void;
