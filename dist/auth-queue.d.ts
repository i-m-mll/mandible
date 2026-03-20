import Database from "better-sqlite3";
import { executeAuthCommand } from "./auth-executor.js";
import type { AuthRequest, AuthRequestInput, AuthRequestStatus, SseEvent } from "./types.js";
export declare class AuthQueueError extends Error {
    readonly code: "not_found" | "invalid_status" | "invalid_command";
    readonly status?: AuthRequestStatus;
    constructor(code: "not_found" | "invalid_status" | "invalid_command", message: string, status?: AuthRequestStatus);
}
export interface AuthQueueOptions {
    db?: InstanceType<typeof Database>;
    now?: () => number;
    ttlMs?: number;
    broadcast?: (event: SseEvent) => void;
    executor?: typeof executeAuthCommand;
}
export declare class AuthQueue {
    private readonly db;
    private readonly now;
    private readonly ttlMs;
    private readonly broadcast;
    private readonly executor;
    private readonly inFlight;
    private executionChain;
    private expiryTimer;
    constructor(options?: AuthQueueOptions);
    private startExpiryTimer;
    /**
     * Recover auth requests that got stuck in 'approved' status because the
     * daemon was killed (e.g. by the post-merge hook) before the executor could
     * record the result.
     *
     * Two cases:
     * 1. Approved with output containing merge evidence → mark completed (exit 0)
     * 2. Approved with empty/no output, older than 5 min → mark completed (exit 1)
     *    as interrupted execution (Bug: 68aa754)
     */
    private recoverStuckRequests;
    /**
     * Find an existing pending request that would be a duplicate of the given
     * payload. Returns the existing request if found, or null.
     *
     * Bug: 16985e8 — agents can accidentally submit the same request multiple
     * times (retry logic, curl fallback). We check two conditions:
     * 1. Same session_id + same title (same agent, same logical operation)
     * 2. Same head_branch + same base_branch (any session, branch can only merge once)
     */
    findDuplicate(payload: AuthRequestInput): AuthRequest | null;
    submit(payload: AuthRequestInput): AuthRequest;
    getRequest(id: string): AuthRequest | null;
    update(id: string, fields: Partial<AuthRequestInput> & {
        status?: "pending" | "dismissed";
    }): AuthRequest;
    listPending(): AuthRequest[];
    /** Return pending + approved + failed/expired + recent history for the UI. */
    listActive(): AuthRequest[];
    /** Return resolved items (completed/rejected/dismissed) ordered by most recent first. */
    listHistory(limit?: number): AuthRequest[];
    retry(id: string): AuthRequest;
    requeue(id: string): AuthRequest;
    dismiss(id: string): AuthRequest;
    delete(id: string, reason: string): void;
    approve(id: string): AuthRequest;
    reject(id: string, reason?: string): AuthRequest;
    skip(id: string): AuthRequest;
    appendOutput(id: string, chunk: string): AuthRequest;
    setResult(id: string, exitCode: number, output: string, error?: string): AuthRequest;
    expireStale(): AuthRequest[];
    /**
     * Recover requests stuck in 'approved'/'executing' with no output for >10 min.
     * Called periodically from expireStale() so stuck requests are recovered at
     * runtime, not only at startup. Uses the same logic as recoverStuckRequests()
     * Case 2 but with a longer threshold (10 min vs 5 min at startup) since the
     * daemon is known to be running.
     * Bug: 831cb3e
     */
    private recoverStuckApproved;
    private executeInBackground;
    private handleOutput;
    private storeExecutionResult;
    private autoDismissDuplicates;
    /**
     * When an auth request completes successfully (exit_code=0), resolve
     * associated work units:
     * 1. Work units whose auth_request_id matches the completed request
     * 2. Work units whose branch matches the auth request's head_branch
     * 3. Work units linked to issue IDs found in Bug: trailers of the commit message
     * Bug: 8a281b3
     */
    private resolveWorkUnitsOnMerge;
    private buildResolvedPayload;
    private isFailedLike;
    private requireRequest;
    private ensureSchema;
}
