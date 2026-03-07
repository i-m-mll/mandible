import type { WorkScanner } from "./work-scanner.js";
import type { GitBugIssueDetail, IssueRepoSummary } from "./types.js";
export declare class IssueScanner {
    private cache;
    private workScanner;
    private scanPromise;
    constructor(workScanner: WorkScanner);
    getRepoSummaries(): IssueRepoSummary[];
    getIssueDetail(repoId: string, issueId: string): GitBugIssueDetail | null;
    /** Look up an issue's status from the cache. Returns null if unknown. */
    getIssueStatus(repoId: string, issueId: string): "open" | "closed" | null;
    scanAll(): IssueRepoSummary[];
    scanAllAsync(): Promise<IssueRepoSummary[]>;
    /**
     * Force-scan a single repo by its repo ID.
     * Returns true if the repo was found and scanned, false otherwise.
     * Used by the /api/issues/:repoId/scan endpoint to unblock deep-link 404s.
     */
    scanRepoById(repoId: string): boolean;
    scanRepoByIdAsync(repoId: string): Promise<boolean>;
    closeIssue(repoId: string, issueId: string): boolean;
    reopenIssue(repoId: string, issueId: string): boolean;
    addComment(repoId: string, issueId: string, message: string): boolean;
    addLabel(repoId: string, issueId: string, label: string): boolean;
    removeLabel(repoId: string, issueId: string, label: string): boolean;
    private ensureScan;
    private scanAllInternalAsync;
    private scanRepo;
    private scanRepoAsync;
    private invalidateRepo;
}
