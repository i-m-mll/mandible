// Executor task inventory HTTP surface (issue 0bc2279).
//
// One credential class writes here: a REGISTERED EXECUTOR — an active agent (or
// the local operator, the administrative principal for every namespace) that is
// explicitly mapped to the executor name it posts under. This is the same trust
// shape as briefing publishers, and deliberately not a capability an arbitrary
// authenticated session inherits: an unmapped identity is a 403 even though it
// authenticated fine. fileRpc is allowed so a sandboxed publisher can reach the
// route over the file transport.
//
// Inventory reads remain open like the rest of the dashboard read surface.
// The only management surface is the disable command protocol below: operator
// intent plus executor receipts, never an in-daemon task mutation.

import { requireIdentity, requireOperator, ClientAuthzError } from "../client-auth/authz.js";
import {
  TASK_COMMAND_EVENTS,
  TASK_COMMAND_SCHEMA,
  TASK_INVENTORY_EVENTS,
} from "../contracts.js";
import { getDb, type Db } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { listManagedReminders } from "../managed-reminders.js";
import {
  getTaskInventoryView,
  parseTaskInventoryGeneration,
  reconcileTaskActivationCondition,
  recordTaskInventoryGeneration,
  TaskInventoryValidationError,
} from "../task-inventory.js";
import {
  appendTaskCommandExecutorEvent,
  cancelTaskCommand,
  createTaskCommand,
  getTaskCommand,
  listTaskCommands,
  parseTaskCommandCreateRequest,
  parseTaskCommandExecutorEvent,
  TaskCommandError,
} from "../task-commands.js";
import { requireMappedTaskExecutor } from "./agent-publisher-auth.js";
import { sendJson } from "./http.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof TaskInventoryValidationError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  if (error instanceof TaskCommandError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

/**
 * Admit an active principal mapped to this executor name, and return the user
 * id that will be recorded on the generation. Attribution comes from the
 * authenticated identity alone — nothing in the payload can name a publisher.
 */
function requireExecutorPublisher(db: Db, req: RequestLike, executorName: string): string {
  return requireMappedTaskExecutor(db, req, executorName, { allowOperator: true }).userId;
}

export function registerTaskRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  // Ingestion: registered-executor class, atomic per generation, idempotent per
  // content digest.
  server.post("/api/tasks/inventory", (req, res) => {
    try {
      // Authenticate before parsing so an anonymous caller learns nothing about
      // payload validation; the mapping check needs the parsed executor name.
      requireIdentity(req);
      const generation = parseTaskInventoryGeneration(req.body);
      const postedByUserId = requireExecutorPublisher(db, req, generation.executor.name);
      const result = recordTaskInventoryGeneration(db, generation, { postedByUserId });
      if (result.stored) {
        broadcast(TASK_INVENTORY_EVENTS.posted, {
          executor: result.executor,
          generation_id: result.generation_id,
          digest: result.digest,
          task_count: result.task_count,
          observed_at: result.observed_at,
        });
      }
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/tasks/inventory", effects: ["process:external"], requestSchema: null, reportingCategory: "tasks" }, fileRpc: "allow" });

  // The whole read surface: latest generation per executor, projected.
  server.get("/api/tasks", (_req, res) => {
    try {
      const inventory = getTaskInventoryView(db);
      const reminders = listManagedReminders(db).map((reminder) => ({
        source_kind: "mandible" as const,
        key: `mandible-reminder:${reminder.id}`,
        reminder,
      }));
      sendJson(res, 200, {
        ...inventory,
        tasks: [...inventory.tasks, ...reminders].sort((a, b) => a.key.localeCompare(b.key)),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/tasks", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Operator command read/create/cancel surface. Disable is the only verb in
  // v1; cancellation is legal only before an executor accepts the request.
  server.get("/api/tasks/commands", (req, res) => {
    try {
      requireOperator(db, req);
      const executor = req.query.executor?.trim() || undefined;
      const taskId = req.query.task_id?.trim() || undefined;
      sendJson(res, 200, {
        commands: listTaskCommands(db, {
          executor,
          taskId,
          // The selected-task UI must see unresolved commands even when that
          // task has more than one history page. The unfiltered audit surface
          // remains capped.
          limit: executor && taskId ? null : undefined,
        }),
        polling: "tick_aligned",
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/tasks/commands", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.post("/api/tasks/commands", (req, res) => {
    try {
      const operator = requireOperator(db, req);
      const request = parseTaskCommandCreateRequest(req.body);
      if (request.schema === TASK_COMMAND_SCHEMA) {
        const executor = getTaskInventoryView(db).executors.find(
          (candidate) => candidate.name === request.executor,
        );
        if (!executor?.capabilities.includes(TASK_COMMAND_SCHEMA)) {
          throw new TaskCommandError(
            `executor '${request.executor}' has not declared capability '${TASK_COMMAND_SCHEMA}'`,
            409,
            "executor_capability_unknown",
          );
        }
      }
      const result = createTaskCommand(
        db,
        request,
        operator.user_id,
      );
      if (result.stored) broadcast(TASK_COMMAND_EVENTS.changed, { command_id: result.command.id });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/tasks/commands", effects: ["process:external"], requestSchema: null, reportingCategory: "tasks" }, fileRpc: "deny" });

  server.post("/api/tasks/commands/:id/cancel", (req, res) => {
    try {
      const operator = requireOperator(db, req);
      const result = cancelTaskCommand(db, req.params.id, operator.user_id);
      if (result.stored) broadcast(TASK_COMMAND_EVENTS.changed, { command_id: result.command.id });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/tasks/commands/:id/cancel", effects: ["process:external"], requestSchema: null, reportingCategory: "tasks" }, fileRpc: "deny" });

  // Executor polling is tick-aligned. Accepted commands remain pending until a
  // terminal receipt so an executor can retry a transient local apply failure.
  server.get("/api/tasks/commands/pending", (req, res) => {
    try {
      const executor = req.query.executor?.trim();
      if (!executor) throw new TaskCommandError("executor query parameter is required");
      requireMappedTaskExecutor(db, req, executor);
      sendJson(res, 200, {
        // A disable is a safety action and must not disappear behind a history
        // page boundary. Only the configured operator can create rows, and
        // terminal rows are excluded, so return the complete pending queue.
        commands: listTaskCommands(db, { executor, pendingOnly: true, limit: null }),
        polling: "tick_aligned",
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/tasks/commands/pending", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Operator-only point read for the active command modal. SSE is the primary
  // wake-up signal; the UI polls this route every two seconds while nonterminal.
  server.get("/api/tasks/commands/:id", (req, res) => {
    try {
      requireOperator(db, req);
      sendJson(res, 200, { command: getTaskCommand(db, req.params.id) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/tasks/commands/:id", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.post("/api/tasks/commands/:id/events", (req, res) => {
    try {
      requireIdentity(req);
      const command = getTaskCommand(db, req.params.id);
      const executor = requireMappedTaskExecutor(db, req, command.executor);
      const event = parseTaskCommandExecutorEvent(command, req.body);
      const result = appendTaskCommandExecutorEvent(
        db,
        command.id,
        event,
        executor.userId,
      );
      reconcileTaskActivationCondition(db, command.executor, command.task_id);
      if (result.stored) broadcast(TASK_COMMAND_EVENTS.changed, { command_id: result.command.id });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/tasks/commands/:id/events", effects: ["process:external"], requestSchema: null, reportingCategory: "tasks" }, fileRpc: "allow" });
}
