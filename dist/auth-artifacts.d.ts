import type { AuthRequest } from "./types.js";
export interface ArtifactRebuildResult {
    changed: boolean;
    committed: boolean;
    commit_sha: string | null;
    output: string;
    files_changed: number;
    additions: number;
    deletions: number;
    diff_summary: string;
    commit_message: string;
}
export declare class ArtifactRebuildError extends Error {
    readonly output: string;
    constructor(message: string, output: string);
}
export declare function rebuildArtifactsForRequest(request: AuthRequest): ArtifactRebuildResult;
