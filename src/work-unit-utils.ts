// Bug: f3dbb3e — shared work-unit liveness computation.
// Canonical mapWorkUnitRow, computeWorkUnitLiveness, and enrichWithLiveness used by
// both routes/work-units.ts and routes/inbox.ts (and routes/issues.ts).

import { getDb, type Db } from "./db.js";
import { getChannelRegistry } from "./channel-registry.js";
import type { SessionManager } from "./session-manager.js";
import {
  resolveSessionAlias,
  type SessionAliasResolution,
} from "./session-liveness.js";
import type { WorkUnit } from "./types.js";

import type { WorkUnitLiveness, WorkUnitWithLiveness } from "./contracts.js";
export type { WorkUnitLiveness, WorkUnitWithLiveness } from "./contracts.js";

export type WorkUnitSessionResolver = (db: Db, id: string) => SessionAliasResolution | null;

export function mapWorkUnitRow(row: Record<string, unknown>): WorkUnit {
  return {
    id: String(row.id ?? ""),
    issue_id: String(row.issue_id ?? ""),
    ledger_issue_id: typeof row.ledger_issue_id === "string" ? row.ledger_issue_id : null,
    repo_id: String(row.repo_id ?? ""),
    branch: typeof row.branch === "string" ? row.branch : null,
    parent_branch: typeof row.parent_branch === "string" ? row.parent_branch : null,
    kind: (row.kind as WorkUnit["kind"]) ?? "solo",
    state: (row.state as WorkUnit["state"]) ?? "open",
    assigned_session_id: normalizeWorkUnitSessionId(row.assigned_session_id),
    provider: typeof row.provider === "string" && row.provider.trim() ? row.provider : null,
    provider_session_id: normalizeWorkUnitSessionId(row.provider_session_id),
    worker_provider_session_id: normalizeWorkUnitSessionId(row.worker_provider_session_id),
    continuation: typeof row.continuation === "string" ? row.continuation : null,
    continuation_by: typeof row.continuation_by === "string" ? row.continuation_by : null,
    continuation_at: typeof row.continuation_at === "number" ? row.continuation_at : null,
    created_at: Number(row.created_at ?? 0),
    activated_at: typeof row.activated_at === "number" ? row.activated_at : null,
    last_commit_at: typeof row.last_commit_at === "number" ? row.last_commit_at : null,
    resolved_at: typeof row.resolved_at === "number" ? row.resolved_at : null,
    auth_request_id: typeof row.auth_request_id === "string" ? row.auth_request_id : null,
    owner_user_id: typeof row.owner_user_id === "string" ? row.owner_user_id : null,
    owner_credential_id: typeof row.owner_credential_id === "string" ? row.owner_credential_id : null,
    custody_generation: Number(row.custody_generation ?? 0),
  };
}

export function normalizeWorkUnitSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** One identity-first liveness rule shared by work-unit routes and issue detail. */
export function computeWorkUnitLiveness(
  db: Db,
  workUnit: WorkUnit,
  sessionManager?: SessionManager,
  sessionResolver: WorkUnitSessionResolver = resolveSessionAlias,
): WorkUnitLiveness {
  const noLiveness: WorkUnitLiveness = {
    state: "stopped",
    agent_session_id: null,
    agent_status: null,
    is_processing: false,
    last_activity: null,
  };

  const identityCandidates = Array.from(new Set([
    workUnit.assigned_session_id,
    workUnit.worker_provider_session_id,
    workUnit.provider_session_id,
  ].filter((value): value is string => Boolean(value))));
  // Unknown outranks stopped: one identity whose check failed means the unit's
  // agent may still be working, whatever its other identities say.
  let notLive: { id: string; resolution: SessionAliasResolution } | null = null;
  for (const id of identityCandidates) {
    const resolution = sessionResolver(db, id);
    if (!resolution) continue;
    if (workUnit.provider && resolution.provider && resolution.provider !== workUnit.provider) continue;
    if (resolution.liveness !== "live") {
      if (!notLive || (resolution.liveness === "unknown" && notLive.resolution.liveness === "stopped")) {
        notLive = { id, resolution };
      }
      continue;
    }
    const status = resolution.mandible_status ?? resolution.console_status ?? "active";
    const lastActivity = resolution.last_activity ? Date.parse(resolution.last_activity) : null;
    return {
      state: "live",
      agent_session_id: resolution.mandible_session_id ?? id,
      agent_status: status,
      is_processing: resolution.console_status === "running"
        || (resolution.mandible_status === "active" && Boolean(resolution.console_session_id)),
      last_activity: lastActivity !== null && Number.isFinite(lastActivity) ? lastActivity : null,
    };
  }
  if (notLive) {
    const { id, resolution } = notLive;
    const lastActivity = resolution.last_activity ? Date.parse(resolution.last_activity) : null;
    return {
      state: resolution.liveness,
      agent_session_id: resolution.mandible_session_id ?? id,
      agent_status: resolution.mandible_status ?? resolution.console_status ?? resolution.liveness,
      is_processing: false,
      last_activity: lastActivity !== null && Number.isFinite(lastActivity) ? lastActivity : null,
    };
  }

  // An explicit provider identity is authoritative. Falling back to a session
  // that merely shares the branch would silently substitute another agent.
  if (identityCandidates.length > 0 || !workUnit.branch) {
    return noLiveness;
  }

  // Find the most recent active/idle session on this branch
  const sessionRow = db
    .prepare(
      `SELECT id, status, last_active FROM sessions
       WHERE branch = ? AND status IN ('active', 'idle')
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(workUnit.branch) as { id: string; status: string; last_active: string | null } | undefined;

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
        state: "live",
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
      state: isAlive ? "live" : "stopped",
      agent_session_id: sessionRow.id,
      agent_status: isAlive ? "active" : "stale",
      is_processing: false,
      last_activity: cs?.last_tool_call ?? null,
    };
  }

  // Check SDK processing state via console_sessions
  let isProcessing = false;
  const consoleRow = db
    .prepare(
      `SELECT id FROM console_sessions
       WHERE mandible_session_id = ? AND status = 'running'
       LIMIT 1`
    )
    .get(sessionRow.id) as { id: string } | undefined;

  if (consoleRow) {
    const backend = sessionManager?.get(consoleRow.id);
    if (backend && "isProcessing" in backend && typeof backend.isProcessing === "boolean") {
      isProcessing = backend.isProcessing;
    }
  }

  const lastActive = sessionRow.last_active ? new Date(sessionRow.last_active).getTime() : null;

  return {
    state: "live",
    agent_session_id: sessionRow.id,
    agent_status: sessionRow.status,
    is_processing: isProcessing,
    last_activity: lastActive,
  };
}

/**
 * Liveness overlay for a work unit, derived at query time and never stored
 * (bug 8a281b3).
 */
export function enrichWithLiveness(
  workUnit: WorkUnit,
  sessionManager: SessionManager,
): WorkUnitWithLiveness {
  return {
    ...workUnit,
    liveness: computeWorkUnitLiveness(getDb(), workUnit, sessionManager),
  };
}
