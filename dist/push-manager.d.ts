import type { WorkScanner, RepoInfo } from "./work-scanner.js";
export type PushScope = "current" | "all_ahead";
export type PushRepoResult = {
    repoId: string;
    repoName: string;
    repoRoot: string;
    branches_pushed: string[];
    refs_pushed: string[];
    skipped: boolean;
    error: string | null;
};
export type PushSessionResult = {
    repos: PushRepoResult[];
    duration_ms: number;
    started_at: string;
};
export declare function getPushStatus(): {
    active: boolean;
    session_id: string | null;
    started_at: string | null;
    repo_count: number;
    completed_count: number;
    done: boolean;
    error: string | null;
};
/**
 * Start a push session for multiple repos. Runs asynchronously and broadcasts
 * SSE events as each repo completes.
 */
export declare function startPushSession(repos: RepoInfo[], scope: PushScope, scanner: WorkScanner): {
    session_id: string;
    started_at: string;
};
/**
 * Push a single repo synchronously (well, async but waits for completion).
 * Used by the single-repo push endpoint.
 */
export declare function pushSingleRepo(repo: RepoInfo, scope: PushScope, scanner: WorkScanner): Promise<PushRepoResult>;
