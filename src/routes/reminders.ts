import { attributionForRequest, requireIdentity, ClientAuthzError } from "../client-auth/authz.js";
import { MANAGED_REMINDER_EVENTS, type ManagedReminderLifecycle } from "../contracts.js";
import { getDb, type Db } from "../db.js";
import {
  cancelManagedReminder,
  createManagedReminder,
  getManagedReminder,
  listManagedReminders,
  ManagedReminderError,
  resolveManagedReminderProject,
} from "../managed-reminders.js";
import {
  ManagedReminderValidationError,
  parseManagedReminderCreateRequest,
} from "../managed-reminder-parser.js";
import { PermissionError, requireProjectAccess, sendPermissionError } from "../permissions/store.js";
import type { RequestLike, ResponseLike, RouteRegistrar, ResolvedClientIdentity } from "../server.js";
import { broadcast } from "../sse.js";
import { getUserById } from "../users/store.js";
import { sendJson } from "./http.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof PermissionError) {
    sendPermissionError(res, error);
    return;
  }
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof ManagedReminderError || error instanceof ManagedReminderValidationError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
}

function requireReminderPrincipal(db: Db, req: RequestLike): ResolvedClientIdentity {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active" || (user.kind !== "human" && user.kind !== "agent")) {
    throw new ClientAuthzError(
      403,
      "active_principal_required",
      "Managed reminder mutations require an active human or agent identity.",
    );
  }
  return identity;
}

function admitProjectWrite(db: Db, req: RequestLike, projectId: string): ResolvedClientIdentity {
  const identity = requireReminderPrincipal(db, req);
  requireProjectAccess(db, req, projectId, "write");
  return identity;
}

function reminderEvidence(db: Db, req: RequestLike, identity: ResolvedClientIdentity):
  "api_token" | "ephemeral" | "local_default" | "session_claim" {
  if (identity.method === "api_token") return "api_token";
  if (identity.method !== "local_socket") return "ephemeral";
  const attribution = attributionForRequest(db, req);
  if (attribution?.user_id !== identity.user_id
      || (attribution.evidence_method !== "local_default" && attribution.evidence_method !== "session_claim")) {
    throw new ClientAuthzError(403, "managed_identity_required", "Local reminder attribution requires one active caller identity.");
  }
  return attribution.evidence_method;
}

function lifecycleFilter(value: string | undefined): ManagedReminderLifecycle | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "armed" || value === "completed" || value === "cancelled") return value;
  throw new ManagedReminderValidationError("lifecycle must be armed, completed, or cancelled");
}

export function registerManagedReminderRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  server.post("/api/reminders", (req, res) => {
    try {
      // Attribution is mandatory even in compat mode. Resolve it before payload
      // parsing so anonymous callers cannot probe this delayed-authority surface.
      requireReminderPrincipal(db, req);
      const request = parseManagedReminderCreateRequest(req.body);
      const project = resolveManagedReminderProject(db, request.project);
      const identity = admitProjectWrite(db, req, project.id);
      const result = createManagedReminder(
        db,
        request,
        { userId: identity.user_id, evidenceMethod: reminderEvidence(db, req, identity) },
        { projectId: project.id },
      );
      if (result.stored) {
        broadcast(MANAGED_REMINDER_EVENTS.changed, {
          task_id: result.reminder.id,
          lifecycle: result.reminder.lifecycle,
        });
        if (result.fired_immediately) {
          broadcast(MANAGED_REMINDER_EVENTS.occurred, {
            task_id: result.reminder.id,
            occurrence_id: result.reminder.occurrence?.id ?? null,
          });
        }
      }
      sendJson(res, result.stored ? 201 : 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/reminders", effects: ["delivery:background"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  server.get("/api/reminders", (req, res) => {
    try {
      const project = req.query.project
        ? resolveManagedReminderProject(db, req.query.project)
        : undefined;
      sendJson(res, 200, {
        reminders: listManagedReminders(db, {
          projectId: project?.id,
          lifecycle: lifecycleFilter(req.query.lifecycle),
        }),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/reminders", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/reminders/:id", (req, res) => {
    try {
      sendJson(res, 200, { reminder: getManagedReminder(db, req.params.id) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/reminders/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/reminders/:id/cancel", (req, res) => {
    try {
      const current = getManagedReminder(db, req.params.id);
      const identity = admitProjectWrite(db, req, current.project_id);
      const reminder = cancelManagedReminder(db, current.id, {
        userId: identity.user_id,
        evidenceMethod: reminderEvidence(db, req, identity),
      });
      broadcast(MANAGED_REMINDER_EVENTS.changed, {
        task_id: reminder.id,
        lifecycle: reminder.lifecycle,
      });
      sendJson(res, 200, { reminder });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/reminders/:id/cancel", effects: ["delivery:background"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });
}
