import type { Db } from "../db.js";
import type { LedgerProjectCheckout } from "./types.js";
import type { GitBugClient } from "./git-bug-client.js";
import { LedgerStore } from "./store.js";
export interface GitBugImportOptions {
    db: Db;
    client: GitBugClient;
    checkout: Pick<LedgerProjectCheckout, "id" | "project_id" | "root">;
    store?: LedgerStore;
}
export interface GitBugImportResult {
    imported: number;
    created: number;
    updated: number;
    comments: number;
    labels: number;
    relationships: number;
    conflicts: number;
    skipped: number;
}
export declare function importGitBugCheckout(options: GitBugImportOptions): Promise<GitBugImportResult>;
