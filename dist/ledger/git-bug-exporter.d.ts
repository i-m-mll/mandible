import type { Db } from "../db.js";
import type { GitBugClient } from "./git-bug-client.js";
import { LedgerStore } from "./store.js";
export interface GitBugExportOptions {
    db: Db;
    client: GitBugClient;
    project_id: string;
    repoRoot: string;
    store?: LedgerStore;
    limit?: number;
}
export interface GitBugExportResult {
    applied: number;
    conflicted: number;
    failed: number;
    retryable: number;
    skipped: number;
}
export declare function exportGitBugOutbox(options: GitBugExportOptions): Promise<GitBugExportResult>;
