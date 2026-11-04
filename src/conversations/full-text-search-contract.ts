import type { ConversationSourceReadinessReason } from "./source-readiness.js";

/** Disposable query leases are unrelated to local user access. */
export interface FullTextSearchProgress {
  eligible: number;
  prepared: number;
  scanned: number;
  matched: number;
}

export type FullTextSearchUnreadReason = Exclude<ConversationSourceReadinessReason, "current"> | "source_changed";

export interface FullTextSearchUnread {
  count: number;
  examples: string[];
}

/** complete is true only when every eligible conversation was read; unread names the rest. */
export interface FullTextSearchCoverage extends FullTextSearchProgress {
  failed: number;
  unread: Partial<Record<FullTextSearchUnreadReason, FullTextSearchUnread>>;
  complete: boolean;
}

export function unsettledCoverage(progress: FullTextSearchProgress = { eligible: 0, prepared: 0, scanned: 0, matched: 0 }): FullTextSearchCoverage {
  return { ...progress, failed: 0, unread: {}, complete: false };
}

export type FullTextSearchReason =
  | "source_unavailable" | "source_changed" | "redaction_changed"
  | "cancelled" | "observer_expired" | "snapshot_expired"
  | "query_mismatch" | "admission_full" | "metadata_limit" | "worker_restarted" | "internal_error";

export interface FullTextSearchPending {
  state: "pending";
  search_id: string;
  observer_token: string;
  phase: "queued" | "preparing" | "scanning";
  progress: FullTextSearchProgress;
  retry_after_ms: number;
}

export interface FullTextSearchTerminal {
  state: "incomplete" | "superseded" | "expired";
  search_id: string;
  reason: FullTextSearchReason;
  detail?: string;
  coverage: FullTextSearchCoverage;
}

/** Only settled responses carry route results, totals or page cursors; coverage says what they cover. */
export type FullTextSearchResponse<Result> =
  | FullTextSearchPending
  | FullTextSearchTerminal
  | (Result & {
      state: "complete";
      search_id: string;
      snapshot_id: string;
      coverage: FullTextSearchCoverage;
    });

export const FULL_TEXT_SEARCH_RETRY_MS = 250;
export const FULL_TEXT_SEARCH_OBSERVER_LEASE_MS = 30_000;
