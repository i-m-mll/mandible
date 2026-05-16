export type GitBugRetryClass = "retryable" | "fatal";
export type GitBugResult<T> = {
    ok: true;
    value: T;
    stdout: string;
    stderr: string;
    exit_code: number;
} | {
    ok: false;
    error: string;
    retry: GitBugRetryClass;
    stdout: string;
    stderr: string;
    exit_code: number | null;
};
export interface GitBugIssueSummary {
    id: string;
    human_id: string;
    title: string;
    status: "open" | "closed";
    labels: string[];
    author_name: string;
    created_at: string;
}
export interface GitBugCommentDetail {
    id: string;
    human_id: string;
    author_name: string;
    body: string;
    created_at: string;
}
export interface GitBugIssueDetail extends GitBugIssueSummary {
    description: string;
    comments: GitBugCommentDetail[];
    raw: unknown;
}
export interface GitBugCreateIssueInput {
    title: string;
    body: string;
    labels?: string[];
}
export interface GitBugClient {
    hasGitBugRefs(repoRoot: string): Promise<GitBugResult<boolean>>;
    listIssues(repoRoot: string): Promise<GitBugResult<GitBugIssueSummary[]>>;
    getIssue(repoRoot: string, ref: string): Promise<GitBugResult<GitBugIssueDetail>>;
    createIssue(repoRoot: string, input: GitBugCreateIssueInput): Promise<GitBugResult<{
        id: string;
    }>>;
    setStatus(repoRoot: string, ref: string, status: "open" | "closed"): Promise<GitBugResult<void>>;
    addComment(repoRoot: string, ref: string, body: string): Promise<GitBugResult<{
        id?: string;
    }>>;
    addLabel(repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>>;
    removeLabel(repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>>;
}
export interface SubprocessGitBugClientOptions {
    timeoutMs?: number;
}
export declare class SubprocessGitBugClient implements GitBugClient {
    private readonly timeoutMs;
    constructor(options?: SubprocessGitBugClientOptions);
    hasGitBugRefs(repoRoot: string): Promise<GitBugResult<boolean>>;
    listIssues(repoRoot: string): Promise<GitBugResult<GitBugIssueSummary[]>>;
    getIssue(repoRoot: string, ref: string): Promise<GitBugResult<GitBugIssueDetail>>;
    createIssue(repoRoot: string, input: GitBugCreateIssueInput): Promise<GitBugResult<{
        id: string;
    }>>;
    setStatus(repoRoot: string, ref: string, status: "open" | "closed"): Promise<GitBugResult<void>>;
    addComment(repoRoot: string, ref: string, body: string): Promise<GitBugResult<{
        id?: string;
    }>>;
    addLabel(repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>>;
    removeLabel(repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>>;
    private runGitBug;
}
export declare function classifyGitBugFailure(message: string): GitBugRetryClass;
