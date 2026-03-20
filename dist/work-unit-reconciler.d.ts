import type { Logger } from "./types.js";
export declare class WorkUnitReconciler {
    private timer;
    private readonly logger;
    constructor(logger: Logger);
    start(): void;
    stop(): void;
    /** Run all reconciliation passes. Safe to call manually for testing. */
    reconcile(): void;
    /**
     * Pass 1: Clear assigned_session_id for work units whose assigned session is dead/ended.
     * The work unit remains in its current state but shows as "unassigned" in liveness.
     */
    private reconcileDeadSessions;
    /**
     * Pass 2: Mark committed work units as abandoned when their branch no longer exists.
     * Uses the branches table from the work scanner to check branch existence.
     */
    private reconcileAbandonedBranches;
    /**
     * Pass 3: Auto-transition open work units to committed when their branch
     * has commits ahead of the default branch (detected via the branches table).
     */
    private reconcileAutoCommit;
}
