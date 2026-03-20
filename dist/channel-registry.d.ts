/** In-memory representation of a channel-connected session. */
export interface ChannelSession {
    session_id: string;
    connected_at: number;
    last_tool_call: number;
    tools_called: string[];
    cwd: string | null;
    branch: string | null;
}
/**
 * In-memory registry of channel-connected sessions. The canonical session
 * data lives in the sessions table (registered via POST /api/sessions/register);
 * this registry is a lightweight overlay tracking channel-specific metadata
 * (tool call recency, which tools have been used).
 */
declare class ChannelRegistry {
    private sessions;
    /**
     * Register or update a channel session. Called on first tool invocation
     * from the MCP channel server.
     */
    register(sessionId: string, cwd: string | null, branch: string | null): ChannelSession;
    /**
     * Record a tool call for a channel session. Updates last_tool_call and
     * adds the tool name to the set of tools called.
     */
    recordToolCall(sessionId: string, toolName: string): void;
    /** Disconnect a channel session (e.g., on MCP server shutdown). */
    disconnect(sessionId: string): void;
    /** Get a specific channel session, or null if not connected. */
    get(sessionId: string): ChannelSession | null;
    /** Check if a session is channel-connected (in-memory check). */
    isChannelConnected(sessionId: string): boolean;
    /**
     * Check if a channel session is alive based on tool call recency.
     * Returns true if the session has called a tool within the staleness window.
     */
    isAlive(sessionId: string): boolean;
    /** Return all channel-connected sessions (including stale). */
    getAll(): ChannelSession[];
    /** Return only alive (non-stale) channel sessions. */
    getAlive(): ChannelSession[];
    /**
     * Return channel sessions on a given branch (alive only).
     * Used by webhook routing to find channel sessions that can receive events.
     */
    getByBranch(branch: string): ChannelSession[];
    /**
     * Prune stale sessions from the in-memory registry.
     * Called periodically by the daemon.
     */
    pruneStale(): string[];
}
export declare function getChannelRegistry(): ChannelRegistry;
/**
 * Check whether a session is channel-connected using the DB column as fallback.
 * Useful when the in-memory registry may not have the session (e.g., after
 * daemon restart) but the DB column persists the state.
 */
export declare function isChannelConnectedInDb(sessionId: string): boolean;
/**
 * Get all channel-connected sessions from the DB (persisted state).
 * Used by the API endpoint GET /api/sessions/channel-connected.
 */
export declare function getChannelConnectedSessionsFromDb(): Array<{
    id: string;
    app: string;
    status: string;
    branch: string | null;
    cwd: string | null;
    channel_connected_at: number;
    channel_last_tool_call: number | null;
}>;
export {};
