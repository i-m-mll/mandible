import type { Db } from "../db.js";
import type { GitBugClient } from "./git-bug-client.js";
import type { LedgerProjectCheckout } from "./types.js";
export type LedgerSyncDirection = "import" | "export" | "full";
export type LedgerSyncJobStatus = "pending" | "running" | "completed" | "failed" | "retryable" | "conflicted";
export interface LedgerSyncJob {
    id: string;
    adapter: string;
    project_id: string;
    checkout_id: string | null;
    root: string;
    direction: LedgerSyncDirection;
    status: LedgerSyncJobStatus;
    attempt_count: number;
    next_retry_at: number | null;
    started_at: number | null;
    finished_at: number | null;
    last_error: string | null;
    stats_json: string;
    created_at: number;
    updated_at: number;
}
export interface RunGitBugSyncOptions {
    db: Db;
    client: GitBugClient;
    checkout: Pick<LedgerProjectCheckout, "id" | "project_id" | "root">;
    direction: LedgerSyncDirection;
}
export declare function runGitBugSync(options: RunGitBugSyncOptions): Promise<LedgerSyncJob>;
export declare function listLedgerSyncJobs(db: Db, filters?: {
    adapter?: string;
    status?: LedgerSyncJobStatus;
}): LedgerSyncJob[];
