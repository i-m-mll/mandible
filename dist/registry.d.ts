import Database from "better-sqlite3";
import type { NavMetadataStatus, Session, SessionStatus } from "./types.js";
type SqliteDatabase = ReturnType<typeof Database>;
export interface SessionInput {
    id: string;
    app: string;
    pid?: number | null;
    pid_start?: string | null;
    cwd?: string | null;
    branch?: string | null;
    worktree?: string | null;
    terminal?: string | null;
    multiplexer?: string | null;
    nav_session?: string | null;
    nav_tab?: string | null;
    nav_pane_id?: string | null;
    nav_extra?: Record<string, unknown> | null;
    task?: string | null;
    status?: SessionStatus;
    parent_id?: string | null;
    agent_type?: string | null;
    description?: string | null;
    conversation_id?: string | null;
}
export interface NavMetadataUpdate {
    nav_tab?: string | null;
    nav_metadata_status: NavMetadataStatus;
    nav_metadata_attempts: number;
    nav_metadata_last_error?: string | null;
    nav_metadata_last_attempt_at?: string | null;
    nav_metadata_next_retry_at?: string | null;
}
export interface SessionUpdate {
    task?: string | null;
    status?: SessionStatus;
    continuation?: string | null;
    pinned?: number | null;
}
export interface ChildSessionInput {
    id?: string;
    app?: string;
    agent_type?: string | null;
    description?: string | null;
    status?: SessionStatus;
}
export interface SessionListOptions {
    status?: SessionStatus;
    app?: string;
    parent_id?: string | null;
}
export declare function ensureSessionSchema(db: SqliteDatabase): void;
export declare function normalizePidStart(value: string | null | undefined): string | null;
export declare function readPidStartTime(pid: number): string | null;
export declare function checkLiveness(session: Session): "alive" | "dead";
/**
 * Write or remove an entry in pinned-panes.tsv for backward compat with the reaper.
 * Bug: 568eca7
 */
export declare function syncPinnedPanesTsv(paneId: string, pinned: boolean): void;
export declare class SessionRegistry {
    private db;
    constructor(db: SqliteDatabase);
    registerSession(input: SessionInput): Session;
    updateSession(id: string, update: SessionUpdate): Session | null;
    endSession(id: string, status?: SessionStatus): Session | null;
    registerChildSession(parentId: string, input: ChildSessionInput): Session | null;
    updateChildStatus(parentId: string, childId: string, status: SessionStatus): Session | null;
    listSessions(options?: SessionListOptions): Session[];
    getSession(id: string): Session | null;
    getSessionByPid(pid: number): Session | null;
    listSessionsNeedingNavMetadata(limit?: number): Session[];
    updateSessionNavMetadata(id: string, update: NavMetadataUpdate): Session | null;
    getSessionTree(id: string): Session | null;
    /**
     * Return IDs of all pinned sessions (lightweight, for reaper consumption).
     * Bug: 568eca7
     */
    getPinnedSessionIds(): string[];
    updateLastActive(sessionId: string, timestamp?: number): void;
    setIdle(sessionId: string): void;
    setActive(sessionId: string): void;
    killSession(id: string): boolean;
    /**
     * Transfer a session's continuation to linked work units when the session ends.
     * Bug: cbbb3d9 — session-to-work-unit continuation transfer
     */
    private transferContinuationToWorkUnit;
    private ensureLiveness;
}
export {};
