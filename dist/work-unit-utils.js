// Bug: f3dbb3e — shared work-unit liveness computation.
// Canonical mapWorkUnitRow, computeLiveness, and enrichWithLiveness used by
// both routes/work-units.ts and routes/inbox.ts (and routes/issues.ts).
import { getDb } from "./db.js";
import { getChannelRegistry } from "./channel-registry.js";
export function mapWorkUnitRow(row) {
    return {
        id: String(row.id ?? ""),
        issue_id: String(row.issue_id ?? ""),
        repo_id: String(row.repo_id ?? ""),
        branch: typeof row.branch === "string" ? row.branch : null,
        parent_branch: typeof row.parent_branch === "string" ? row.parent_branch : null,
        kind: row.kind ?? "solo",
        state: row.state ?? "open",
        assigned_session_id: typeof row.assigned_session_id === "string" ? row.assigned_session_id : null,
        continuation: typeof row.continuation === "string" ? row.continuation : null,
        continuation_by: typeof row.continuation_by === "string" ? row.continuation_by : null,
        continuation_at: typeof row.continuation_at === "number" ? row.continuation_at : null,
        created_at: Number(row.created_at ?? 0),
        activated_at: typeof row.activated_at === "number" ? row.activated_at : null,
        last_commit_at: typeof row.last_commit_at === "number" ? row.last_commit_at : null,
        resolved_at: typeof row.resolved_at === "number" ? row.resolved_at : null,
        auth_request_id: typeof row.auth_request_id === "string" ? row.auth_request_id : null,
    };
}
/**
 * Compute liveness overlay for a work unit by joining to sessions and console_sessions.
 * Bug: 8a281b3 — liveness is derived at query time, never stored.
 */
export function computeLiveness(workUnit, _sessionRegistry, sessionManager) {
    const db = getDb();
    const noLiveness = {
        has_live_agent: false,
        agent_session_id: null,
        agent_status: null,
        is_processing: false,
        last_activity: null,
    };
    if (!workUnit.branch) {
        return noLiveness;
    }
    // Find the most recent active/idle session on this branch
    const sessionRow = db
        .prepare(`SELECT id, status, last_active FROM sessions
       WHERE branch = ? AND status IN ('active', 'idle')
       ORDER BY updated_at DESC LIMIT 1`)
        .get(workUnit.branch);
    if (!sessionRow) {
        // Bug: 0b454df — check channel-connected sessions as a liveness source.
        // Channel sessions may be on this branch without being found by the
        // session query above (e.g., if the session was registered with a slightly
        // different branch format). Check the channel registry directly.
        const channelRegistry = getChannelRegistry();
        const channelOnBranch = channelRegistry.getByBranch(workUnit.branch);
        if (channelOnBranch.length > 0) {
            const cs = channelOnBranch[0];
            return {
                has_live_agent: true,
                agent_session_id: cs.session_id,
                agent_status: "active",
                is_processing: false,
                last_activity: cs.last_tool_call,
            };
        }
        return noLiveness;
    }
    // Bug: 0b454df — if the session is channel-connected, check freshness
    // via the channel registry rather than relying solely on PID/console state.
    const channelRegistry = getChannelRegistry();
    if (channelRegistry.isChannelConnected(sessionRow.id)) {
        const isAlive = channelRegistry.isAlive(sessionRow.id);
        const cs = channelRegistry.get(sessionRow.id);
        return {
            has_live_agent: isAlive,
            agent_session_id: sessionRow.id,
            agent_status: isAlive ? "active" : "stale",
            is_processing: false,
            last_activity: cs?.last_tool_call ?? null,
        };
    }
    // Check SDK processing state via console_sessions
    let isProcessing = false;
    const consoleRow = db
        .prepare(`SELECT id FROM console_sessions
       WHERE mandible_session_id = ? AND status = 'running'
       LIMIT 1`)
        .get(sessionRow.id);
    if (consoleRow) {
        const backend = sessionManager.get(consoleRow.id);
        if (backend && "isProcessing" in backend && typeof backend.isProcessing === "boolean") {
            isProcessing = backend.isProcessing;
        }
    }
    const lastActive = sessionRow.last_active ? new Date(sessionRow.last_active).getTime() : null;
    return {
        has_live_agent: true,
        agent_session_id: sessionRow.id,
        agent_status: sessionRow.status,
        is_processing: isProcessing,
        last_activity: lastActive,
    };
}
export function enrichWithLiveness(workUnit, sessionRegistry, sessionManager) {
    return {
        ...workUnit,
        liveness: computeLiveness(workUnit, sessionRegistry, sessionManager),
    };
}
