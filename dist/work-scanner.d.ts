import { type SseEvent } from "./sse.js";
export interface LastCommit {
    hash: string;
    message: string;
    author: string;
    date: string;
}
export interface BranchData {
    repo_root: string;
    repo_id?: string;
    branch: string;
    is_current: boolean;
    is_worktree: boolean;
    worktree_path: string | null;
    is_dirty: boolean;
    ahead: number;
    behind: number;
    has_upstream: boolean;
    upstream?: string | null;
    ahead_default: number;
    behind_default: number;
    default_branch: string;
    last_commit: LastCommit | null;
    last_commit_date?: string | null;
    diff_stat: string | null;
}
export interface RepoInfo {
    id: string;
    name: string;
    root: string;
    exists: boolean;
    default_branch: string;
}
export interface ScanSummary {
    scanned_repos: number;
    branches_updated: number;
    branches_removed: number;
    missing_repos: string[];
    duration_ms: number;
}
export interface WorkScannerOptions {
    db?: SqliteDatabase;
    repo_roots?: string[];
    default_repo_root?: string;
    config_path?: string;
    on_event?: (event: SseEvent) => void;
}
export interface SqliteStatement {
    run(...args: unknown[]): {
        changes?: number;
    };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
}
export interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
}
export declare class WorkScanner {
    private readonly db;
    private readonly defaultRepoRoot;
    private readonly configPath;
    private readonly repoRootsOverride;
    private readonly emit;
    private repoInfos;
    constructor(options?: WorkScannerOptions);
    getRepos(): RepoInfo[];
    hasCachedData(): boolean;
    getRepoById(idOrPath: string): RepoInfo | undefined;
    getBranches(repoRoot: string): BranchData[];
    getBranch(repoRoot: string, branch: string): BranchData | null;
    getWorktrees(repoRoot: string): Array<{
        branch: string;
        path: string;
        is_current: boolean;
    }>;
    scanAll(): Promise<ScanSummary>;
    private refreshRepoInfos;
    private resolveRepoRoots;
    private isGitRepo;
    private scanRepo;
    private listBranches;
    private listWorktrees;
    private getWorktreeStatus;
    private getLastCommit;
    private getUpstreamInfo;
    private detectDefaultBranch;
    private getAheadBehindDefault;
    private getAheadBehind;
}
