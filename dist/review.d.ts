export type DiffFile = {
    path: string;
    additions: number;
    deletions: number;
    hunks: unknown[];
};
export type DiffResult = {
    raw: string;
    stat: string;
    files: DiffFile[];
    html: string;
};
export type SpecResult = {
    source: string;
    raw: string;
    html: string;
};
export type CommitLogEntry = {
    hash: string;
    short_hash: string;
    message: string;
    author: string;
    date: string;
    co_authors: string[];
};
export type CommitLogResult = {
    commits: CommitLogEntry[];
    total: number;
};
export declare const getDiff: (repoPath: string, base: string, head: string) => Promise<DiffResult>;
export declare const getSpec: (repoPath: string, branch: string) => Promise<SpecResult>;
export declare const getCommitLog: (repoPath: string, base: string, head: string) => Promise<CommitLogResult>;
