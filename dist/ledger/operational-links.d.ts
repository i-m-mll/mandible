import type { Db } from "../db.js";
import type { LedgerIssueResolution } from "./types.js";
export type OperationalLinkMismatchType = "unavailable" | "not_found" | "ambiguous";
export type OperationalLinkReportStatus = "clean" | "incomplete" | "failed";
export interface ResolveOperationalIssueOk {
    ok: true;
    issue_id: string;
    project_id: string;
}
export interface ResolveOperationalIssueError {
    ok: false;
    error: OperationalLinkMismatchType;
    matches?: string[];
}
export type ResolveOperationalIssueResult = ResolveOperationalIssueOk | ResolveOperationalIssueError;
export type OperationalLinkResult = ResolveOperationalIssueResult & {
    source_table?: string;
    source_id?: string;
    issue_ref?: string;
    repo_id?: string;
};
export interface OperationalLinkMismatch {
    id?: string;
    source_table: string;
    source_id: string;
    repo_id: string;
    issue_ref: string;
    mismatch_type: OperationalLinkMismatchType;
    metadata?: Record<string, unknown>;
}
export interface OperationalLinkReport {
    id: string;
    status: OperationalLinkReportStatus;
    resolved_count: number;
    unresolved_count: number;
    ambiguous_count: number;
    source_counts: Record<string, number>;
    error: string | null;
    started_at: number;
    finished_at: number | null;
    mismatches: OperationalLinkMismatch[];
}
interface LinkOptions {
    source?: string;
    now?: number;
    metadata?: Record<string, unknown>;
    recordEvent?: boolean;
}
export declare function ledgerOperationalLinksAvailable(db: Db): boolean;
export declare function resolveOperationalIssueRef(db: Db, issueRef: string, repoRef?: string | null): ResolveOperationalIssueResult;
export declare function linkWorkUnitToLedgerIssue(db: Db, input: {
    work_unit_id: string;
    issue_ref: string;
    repo_ref: string;
    link_type?: string;
} & LinkOptions): OperationalLinkResult;
export declare function linkSessionToLedgerIssue(db: Db, input: {
    session_id: string;
    issue_ref: string;
    repo_ref: string;
    link_type?: string;
} & LinkOptions): OperationalLinkResult;
export declare function linkAuthRequestToLedgerIssue(db: Db, input: {
    auth_request_id: string;
    issue_ref: string;
    repo_ref?: string | null;
    link_type?: string;
} & LinkOptions): OperationalLinkResult;
export declare function linkCommitToLedgerIssue(db: Db, input: {
    commit_sha: string;
    issue_ref: string;
    repo_ref: string;
    link_type?: string;
} & LinkOptions): OperationalLinkResult;
export declare function syncAuthRequestLedgerLinks(db: Db, input: {
    auth_request_id: string;
    repo_ref?: string | null;
    issue_references?: string[] | null;
    issue_closures?: string[] | null;
    issue_ids?: string[] | null;
    issues?: string[] | null;
    commit_message?: string | null;
    recordEvent?: boolean;
}): OperationalLinkResult[];
export declare function applyAuthRequestLedgerCompletion(db: Db, input: {
    auth_request_id: string;
    repo_ref?: string | null;
    issue_references?: string[] | null;
    issue_closures?: string[] | null;
    issue_ids?: string[] | null;
    issues?: string[] | null;
    commit_message?: string | null;
    approval_source?: string | null;
    approval_lease_id?: string | null;
    resolution?: LedgerIssueResolution;
}): OperationalLinkResult[];
export declare function runOperationalLinkBackfill(db: Db): OperationalLinkReport;
export declare function listOperationalLinkReports(db: Db, limit?: number): OperationalLinkReport[];
export {};
