/** Disposable query leases are unrelated to local user access. */
export interface FullTextSearchProgress {
  eligible: number;
  prepared: number;
  scanned: number;
  matched: number;
}

export interface FullTextSearchCoverage extends FullTextSearchProgress {
  failed: number;
  complete: boolean;
}

export type FullTextSearchReason =
  | "source_unavailable" | "source_changed" | "redaction_changed"
  | "cancelled" | "observer_expired" | "snapshot_expired"
  | "query_mismatch" | "admission_full" | "metadata_limit" | "worker_restarted";

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
  coverage: FullTextSearchCoverage;
}

/** Only complete responses carry route results, exact totals or page cursors. */
export type FullTextSearchResponse<Result> =
  | FullTextSearchPending
  | FullTextSearchTerminal
  | (Result & {
      state: "complete";
      search_id: string;
      snapshot_id: string;
      coverage: FullTextSearchCoverage & { complete: true };
    });

export const FULL_TEXT_SEARCH_RETRY_MS = 250;
export const FULL_TEXT_SEARCH_OBSERVER_LEASE_MS = 30_000;
