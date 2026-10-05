import {
  ClientAuthzError,
  requireIdentity,
  requireOperator,
} from "../client-auth/authz.js";
import {
  OPERATIONAL_INCIDENT_EVENTS,
  type OperationalIncidentAttention,
} from "../contracts.js";
import { getDb, type Db } from "../db.js";
import {
  acknowledgeOperationalIncident,
  closeOperationalIncident,
  countOperationalIncidents,
  ingestOperationalIncidentEnvelope,
  listOperationalIncidents,
  OperationalIncidentError,
  parseOperationalIncidentEnvelope,
} from "../operational-incidents.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { getUserById } from "../users/store.js";
import { requireMappedTaskExecutor } from "./agent-publisher-auth.js";
import { sendJson } from "./http.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError || error instanceof OperationalIncidentError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
}

function requireActiveHuman(db: Db, req: RequestLike): string {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    throw new ClientAuthzError(403, "forbidden", "The authenticated user is not active.");
  }
  if (user.kind !== "human") {
    throw new ClientAuthzError(
      403,
      "human_incident_actor_required",
      "Operational incident acknowledgement requires an active human credential.",
    );
  }
  return user.id;
}

function exactBody(req: RequestLike, keys: readonly string[]): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new OperationalIncidentError("request body must be an object");
  }
  const body = req.body as Record<string, unknown>;
  const actual = Object.keys(body).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new OperationalIncidentError(`request body must contain only: ${keys.join(", ")}`);
  }
  return body;
}

function queryValue(req: RequestLike, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function registerOperationalIncidentRoutes(
  server: RouteRegistrar,
  db: Db = getDb(),
): void {
  server.post("/api/operational-incidents/ingest", (req, res) => {
    try {
      // Authentication precedes parsing. Mapping necessarily follows parsing
      // because the authenticated principal is matched to executor.name.
      requireIdentity(req);
      const envelope = parseOperationalIncidentEnvelope(req.body);
      const publisher = requireMappedTaskExecutor(db, req, envelope.executor.name);
      const result = ingestOperationalIncidentEnvelope(db, envelope, publisher.userId);
      const incidentIds = [...new Set(result.accepted.map((receipt) => receipt.incident_id))];
      broadcast(OPERATIONAL_INCIDENT_EVENTS.ingested, {
        incident_ids: incidentIds,
        badge_count: countOperationalIncidents(db).active_unacknowledged,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/operational-incidents/ingest", effects: ["ledger:write"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  server.get("/api/operational-incidents", (req, res) => {
    try {
      const status = queryValue(req, "status") ?? "active";
      if (!(["active", "resolved", "all"] as const).includes(status as never)) {
        throw new OperationalIncidentError("status must be active, resolved, or all");
      }
      const attention = queryValue(req, "attention") ?? "all";
      if (!(["unacknowledged", "acknowledged", "all"] as const).includes(attention as never)) {
        throw new OperationalIncidentError(
          "attention must be unacknowledged, acknowledged, or all",
        );
      }
      const rawLimit = queryValue(req, "limit");
      const limit = rawLimit === undefined ? 100 : Number(rawLimit);
      sendJson(res, 200, listOperationalIncidents(db, {
        status: status as "active" | "resolved" | "all",
        attention: attention as OperationalIncidentAttention | "all",
        executor: queryValue(req, "executor"),
        task: queryValue(req, "task"),
        limit,
        cursor: queryValue(req, "cursor"),
      }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/operational-incidents", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/operational-incidents/:id/acknowledge", (req, res) => {
    try {
      const actorUserId = requireActiveHuman(db, req);
      const body = exactBody(req, ["expected_attention"]);
      if (body.expected_attention !== "unacknowledged") {
        throw new OperationalIncidentError("expected_attention must be 'unacknowledged'");
      }
      const result = acknowledgeOperationalIncident(db, req.params.id, actorUserId);
      broadcast(OPERATIONAL_INCIDENT_EVENTS.acknowledged, {
        incident_ids: [req.params.id],
        badge_count: countOperationalIncidents(db).active_unacknowledged,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/operational-incidents/:id/acknowledge", effects: ["ledger:write"], requestSchema: null, reportingCategory: "api" }, fileRpc: "deny" });

  server.post("/api/operational-incidents/:id/close", (req, res) => {
    try {
      const operator = requireOperator(db, req);
      const body = exactBody(req, ["reason", "expected_updated_at"]);
      if (typeof body.reason !== "string" || !body.reason.trim()) {
        throw new OperationalIncidentError("reason must be a non-empty string");
      }
      if (!Number.isSafeInteger(body.expected_updated_at)) {
        throw new OperationalIncidentError("expected_updated_at must be an integer");
      }
      const incident = closeOperationalIncident(
        db,
        req.params.id,
        operator.user_id,
        body.reason,
        body.expected_updated_at as number,
      );
      broadcast(OPERATIONAL_INCIDENT_EVENTS.closed, {
        incident_ids: [req.params.id],
        badge_count: countOperationalIncidents(db).active_unacknowledged,
      });
      sendJson(res, 200, { incident });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/operational-incidents/:id/close", effects: ["ledger:write"], requestSchema: null, reportingCategory: "api" }, fileRpc: "deny" });
}
