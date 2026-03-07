import { SessionRegistry } from "./registry.js";
import { WorkScanner } from "./work-scanner.js";
import type { Db } from "./db.js";
import type { Logger } from "./types.js";
export interface DiscoveryResult {
    discovered: number;
    dead_reaped: number;
    already_tracked: number;
    processes_found: number;
    duration_ms: number;
}
/**
 * Discovers agent sessions from running processes and worktrees,
 * and reaps dead sessions whose PIDs are no longer alive.
 */
export declare class SessionDiscovery {
    private readonly db;
    private readonly registry;
    private readonly workScanner;
    private readonly log;
    constructor(db: Db, registry: SessionRegistry, workScanner: WorkScanner, logger: Logger);
    /** Run a full discovery pass: find new sessions and reap dead ones. */
    discoverSessions(): DiscoveryResult;
    /** Mark active sessions whose PIDs are no longer alive as dead. */
    reapDeadSessions(): number;
    /**
     * Collect all worktree paths from every repo the work scanner knows about.
     * Uses `git worktree list --porcelain` the same way WorkScanner does.
     */
    private getWorktreePaths;
    /**
     * Find running agent processes (claude, codex) and resolve their cwds.
     * Uses `ps` + `lsof` on macOS.
     */
    private findAgentProcesses;
    /**
     * Get the current working directory of a process.
     * On macOS, `lsof -a -p PID -d cwd -Fn` is the reliable approach.
     */
    private getProcessCwd;
    private isProcessAlive;
}
export interface ReaperStatus {
    running: boolean;
    interval_ms: number;
    last_run_at: string | null;
    last_run_duration_ms: number | null;
    last_run_reaped: number | null;
    next_run_at: string | null;
    total_reaped: number;
    total_runs: number;
}
/**
 * Periodic reaper that automatically marks dead sessions.
 * Runs on a configurable interval (default 60s) and exposes status
 * for the GET /api/reaper/status endpoint.
 */
export declare class ReaperTimer {
    private timer;
    private readonly discovery;
    private readonly log;
    private readonly intervalMs;
    private _lastRunAt;
    private _lastRunDurationMs;
    private _lastRunReaped;
    private _totalReaped;
    private _totalRuns;
    constructor(discovery: SessionDiscovery, logger: Logger, intervalMs?: number);
    /** Start the periodic reaper. Safe to call multiple times. */
    start(): void;
    /** Stop the periodic reaper. */
    stop(): void;
    /** Get current reaper status for the API endpoint. */
    getStatus(): ReaperStatus;
    private tick;
}
