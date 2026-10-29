// Agent dispatch HTTP surface (umbrella 99b74d6 / issue ce83a84).
//
// Starting an agent is the most consequential thing this dashboard can do from
// a single click, so these routes sit in the same enforcement class as the
// briefing decision routes:
//
//   - HUMAN ONLY. Publisher and agent credential classes are rejected here, at
//     the boundary. No ingestion path, scheduled task, or worker session can
//     dispatch another agent through this API — auto-dispatch is a non-goal of
//     this lane, and this is where that is enforced rather than assumed.
//   - fileRpc: DENY on every mutating route, including the preview. A sandboxed
//     file-transport caller cannot reach them at all.
//   - Read-only instances refuse them through the central operational-mutation
//     gate (src/instance-policy.ts, category `agent_dispatch`).
//
// `preview` writes nothing anywhere: it exists so the confirmation dialog can
// show the exact prompt the worker would receive. Declining after a preview
// leaves no comment, no handling event, no prompt file, and no session.
//
// `dispatch` answers 200 with `{ok, event}` even when the spawn fails. The
// request succeeded — Mandible recorded a handling event — and the spawn
// outcome is data on that event, which the UI reports honestly rather than
// swallowing into a generic error.

import {
  AgentDispatchError,
  dispatchAgent,
  listAgentDispatchEvents,
  previewAgentDispatch,
  type AgentDispatchSubjectInput,
} from "../agent-dispatch.js";
import { requireIdentity, ClientAuthzError } from "../client-auth/authz.js";
import { OPERATIONAL_INCIDENT_EVENTS } from "../contracts.js";
import { getDb, type Db } from "../db.js";
import {
  OperationalIncidentError,
} from "../operational-incidents.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { getUserById } from "../users/store.js";
import { bodyRecord, sendJson } from "./http.js";
function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof AgentDispatchError) {
    sendJson(res, error.status, { error: error.message, ...error.details });
    return;
  }
  if (error instanceof OperationalIncidentError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

/**
 * Admit only a live human principal. Identical in spirit to the briefing
 * reviewer gate: attribution comes from the authenticated user id, never from
 * an `agent_session` hint or any client-supplied actor field.
 */
function requireHumanDispatcher(db: Db, req: RequestLike): string {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    throw new ClientAuthzError(403, "forbidden", "The authenticated user is not active.");
  }
  if (user.kind !== "human") {
    throw new ClientAuthzError(
      403,
      "human_dispatcher_required",
      "Starting an agent requires a human credential; agent and publisher "
        + "credentials may not dispatch agents.",
    );
  }
  return user.id;
}


/** Parse the subject strictly; an unrecognized shape never becomes a default. */
function parseSubject(value: unknown): AgentDispatchSubjectInput {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  if (row.kind === "issue" && typeof row.issue_ref === "string" && row.issue_ref.trim()) {
    return { kind: "issue", issue_ref: row.issue_ref.trim() };
  }
  if (row.kind === "incident" && typeof row.incident_id === "string" && row.incident_id.trim()) {
    return { kind: "incident", incident_id: row.incident_id.trim() };
  }
  throw new AgentDispatchError(
    "subject must be {kind:'issue',issue_ref} or {kind:'incident',incident_id}",
  );
}

function requiredSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new AgentDispatchError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function registerAgentDispatchRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  // Confirmation source of truth. No storage, no filesystem, no process.
  server.post("/api/agent-dispatch/preview", (req, res) => {
    try {
      const actorUserId = requireHumanDispatcher(db, req);
      const body = bodyRecord(req);
      const plan = previewAgentDispatch(db, {
        subject: parseSubject(body.subject),
        instruction: body.instruction,
        actorUserId,
      });
      sendJson(res, 200, { plan });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/agent-dispatch/preview", effects: ["process:external"], requestSchema: null, reportingCategory: "agent_dispatch" }, fileRpc: "deny" });

  server.post("/api/agent-dispatch/dispatch", async (req, res) => {
    try {
      const actorUserId = requireHumanDispatcher(db, req);
      const body = bodyRecord(req);
      const subject = parseSubject(body.subject);
      const outcome = await dispatchAgent(db, {
        subject,
        instruction: body.instruction,
        actorUserId,
        ...(subject.kind === "incident" ? {
          expectedPromptSha256: requiredSha256(
            body.expected_prompt_sha256,
            "expected_prompt_sha256",
          ),
          expectedIncidentTelemetrySha256: requiredSha256(
            body.expected_incident_telemetry_sha256,
            "expected_incident_telemetry_sha256",
          ),
        } : {}),
      });
      if (outcome.incident) {
        broadcast(OPERATIONAL_INCIDENT_EVENTS.remediationChanged, { incident_ids: [outcome.incident.id] });
      }
      sendJson(res, 200, {
        ok: outcome.ok,
        event: outcome.event,
        ...(outcome.incident ? { incident: outcome.incident } : {}),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/agent-dispatch/dispatch", effects: ["process:external"], requestSchema: null, reportingCategory: "agent_dispatch" }, fileRpc: "deny" });

  // Read surface so a reloaded page can still show the audit chain.
  server.get("/api/agent-dispatch/events", (req, res) => {
    try {
      const issueId = typeof req.query?.issue_id === "string" && req.query.issue_id.trim()
        ? req.query.issue_id.trim()
        : undefined;
      const incidentId = typeof req.query?.incident_id === "string" && req.query.incident_id.trim()
        ? req.query.incident_id.trim()
        : undefined;
      const limitRaw = typeof req.query?.limit === "string" ? Number(req.query.limit) : Number.NaN;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : undefined;
      sendJson(res, 200, {
        events: listAgentDispatchEvents(db, { issueId, incidentId, limit }),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/agent-dispatch/events", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
}
