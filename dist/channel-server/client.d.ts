import type { InboxResponse, AuthQueueResponse, IssueRepoSummary, WorkUnitsResponse, AuthSubmitResponse, SessionUpdateResponse } from "./types.js";
export declare class MandibleClientError extends Error {
    readonly statusCode: number | null;
    readonly cause?: unknown | undefined;
    constructor(message: string, statusCode: number | null, cause?: unknown | undefined);
}
export declare function checkInbox(branch?: string, repo?: string): Promise<InboxResponse>;
export declare function checkInboxGlobal(): Promise<InboxResponse>;
export declare function getIssues(filters?: {
    repo?: string;
    status?: string;
    label?: string;
}): Promise<IssueRepoSummary[]>;
export declare function getWorkUnits(filters?: {
    state?: string;
    repo_id?: string;
    branch?: string;
    issue_id?: string;
}): Promise<WorkUnitsResponse>;
export declare function patchWorkUnit(id: string, patch: {
    state?: string;
    assigned_session_id?: string | null;
    continuation?: string | null;
    continuation_by?: string | null;
    continuation_at?: number | null;
}): Promise<unknown>;
export declare function getAuthQueue(): Promise<AuthQueueResponse>;
export declare function submitAuth(payload: {
    command: string;
    title: string;
    cwd?: string | null;
    diff_summary?: string | null;
    commit_message?: string | null;
    spec_content?: string | null;
    repo?: string;
    base_branch?: string;
    head_branch?: string;
    issues?: string[] | null;
    session_id?: string | null;
}): Promise<AuthSubmitResponse>;
/** Bug: 0b454df — register a channel-connected session with Mandible. */
export declare function registerSession(payload: {
    id: string;
    app: string;
    status?: string;
    cwd?: string | null;
    branch?: string | null;
}): Promise<SessionUpdateResponse>;
/** Bug: 0b454df — notify Mandible that a channel tool was called. */
export declare function recordChannelToolCall(sessionId: string, toolName: string): Promise<void>;
export declare function updateSession(sessionId: string, patch: Record<string, unknown>): Promise<SessionUpdateResponse>;
