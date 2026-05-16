import type { Db } from "../db.js";
import type { IssueScanner } from "../issue-scanner.js";
import type { GitBugIssueDetail, IssueRepoSummary } from "../types.js";
import type { WorkScanner } from "../work-scanner.js";
export type LedgerIssueReadMode = "scanner" | "shadow" | "ledger";
export type LedgerIssueWriteMode = "git_bug" | "dual" | "ledger";
export type ReconciliationStatus = "running" | "clean" | "mismatch" | "failed";
export interface LedgerIssueMigrationConfig {
    read_mode: LedgerIssueReadMode;
    write_mode: LedgerIssueWriteMode;
    shadow_report_enabled: boolean;
    fallback_on_ledger_error: boolean;
}
export interface ReconciliationMismatch {
    id?: string;
    project_id?: string;
    repo_id: string;
    issue_ref: string;
    mismatch_type: "missing_in_ledger" | "extra_in_ledger" | "title_mismatch" | "body_hash_mismatch" | "status_mismatch" | "label_set_mismatch" | "comment_count_mismatch" | "comment_hash_mismatch" | "parent_child_mismatch" | "ambiguous_alias";
    scanner_value: unknown;
    ledger_value: unknown;
    metadata?: Record<string, unknown>;
}
export interface ReconciliationReport {
    id: string;
    read_mode: LedgerIssueReadMode;
    status: ReconciliationStatus;
    scanner_issue_count: number;
    ledger_issue_count: number;
    scanner_open_count: number;
    ledger_open_count: number;
    scanner_closed_count: number;
    ledger_closed_count: number;
    mismatch_count: number;
    summary: Record<string, unknown>;
    error: string | null;
    started_at: number;
    finished_at: number | null;
    mismatches: ReconciliationMismatch[];
}
export declare function getLedgerIssueMigrationConfig(db: Db): LedgerIssueMigrationConfig;
export declare function updateLedgerIssueMigrationConfig(db: Db, patch: Partial<LedgerIssueMigrationConfig>): LedgerIssueMigrationConfig;
export declare function listLedgerIssueSummaries(db: Db, workScanner: Pick<WorkScanner, "getRepos">): IssueRepoSummary[];
export declare function findLedgerIssueAcrossRepos(db: Db, workScanner: Pick<WorkScanner, "getRepos">, issueRef: string): {
    ok: true;
    detail: GitBugIssueDetail;
} | {
    ok: false;
    status: 404 | 409;
    error: string;
};
export declare function getLedgerIssueDetailForRoute(db: Db, workScanner: Pick<WorkScanner, "getRepos" | "getRepoById">, repoRef: string, issueRef: string): {
    ok: true;
    detail: GitBugIssueDetail;
} | {
    ok: false;
    status: 404 | 409;
    error: string;
};
export declare function resolveLedgerIssueIdForRoute(db: Db, workScanner: Pick<WorkScanner, "getRepos" | "getRepoById">, repoRef: string, issueRef: string): {
    ok: true;
    issue_id: string;
    project_id: string;
    repo_id: string;
} | {
    ok: false;
    status: 404 | 409;
    error: string;
};
export declare function reconcileIssueSummaries(scannerSummaries: IssueRepoSummary[], ledgerSummaries: IssueRepoSummary[], readMode?: LedgerIssueReadMode): ReconciliationReport;
export declare function runIssueReconciliation(db: Db, issueScanner: Pick<IssueScanner, "getRepoSummaries">, workScanner: Pick<WorkScanner, "getRepos">, readMode?: LedgerIssueReadMode): ReconciliationReport;
export declare function listReconciliationReports(db: Db, limit?: number): ReconciliationReport[];
export declare function getReconciliationReport(db: Db, id: string): ReconciliationReport | null;
export declare function parseMigrationConfigPatch(body: Record<string, unknown> | null): Partial<LedgerIssueMigrationConfig>;
export declare function isLedgerWriteModeEnabled(config: LedgerIssueMigrationConfig): boolean;
