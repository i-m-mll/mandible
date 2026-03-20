import type { SessionRegistry } from "./registry.js";
import type { SessionManager } from "./session-manager.js";
import type { WorkUnit } from "./types.js";
export interface WorkUnitLiveness {
    has_live_agent: boolean;
    agent_session_id: string | null;
    agent_status: string | null;
    is_processing: boolean;
    last_activity: number | null;
}
export interface WorkUnitWithLiveness extends WorkUnit {
    liveness: WorkUnitLiveness;
}
export declare function mapWorkUnitRow(row: Record<string, unknown>): WorkUnit;
/**
 * Compute liveness overlay for a work unit by joining to sessions and console_sessions.
 * Bug: 8a281b3 — liveness is derived at query time, never stored.
 */
export declare function computeLiveness(workUnit: WorkUnit, _sessionRegistry: SessionRegistry, sessionManager: SessionManager): WorkUnitLiveness;
export declare function enrichWithLiveness(workUnit: WorkUnit, sessionRegistry: SessionRegistry, sessionManager: SessionManager): WorkUnitWithLiveness;
